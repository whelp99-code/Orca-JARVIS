import { JarvisError } from "./db.js";
import { MemoryOutboxStore } from "./memory-outbox-store.js";
import type {
  MemoryObservation,
  MemoryOutboxCycleResult,
  MemoryOutboxSagaV2,
  MemoryOutboxServiceOptions,
} from "./memory-outbox-types.js";
import { requireDuration, requireLimit, requireWorker } from "./memory-outbox-values.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import type { SecondBrainEvidence, SecondBrainReadOutcome } from "./second-brain-adapter-types.js";

const DEFAULT_LEASE_MS = 60_000;
export const MEMORY_OUTBOX_RUNTIME_DEADLINE_MS = 600_000;
const empty = (): MemoryOutboxCycleResult => ({
  claimed: 0, dispatched: 0, reconciling: 0, settled: 0, conflicts: 0, failed: 0,
});
export class MemoryOutboxService {
  private readonly store: MemoryOutboxStore;
  private readonly leaseMs: number;
  private readonly deadlineMs: number;
  constructor(private readonly options: MemoryOutboxServiceOptions) {
    this.leaseMs = requireDuration(options.leaseMs ?? DEFAULT_LEASE_MS);
    this.deadlineMs = requireDuration(options.artifactDeadlineMs ?? MEMORY_OUTBOX_RUNTIME_DEADLINE_MS);
    this.store = new MemoryOutboxStore(options.authority, this.deadlineMs);
  }
  enqueue(command: ClaimedControlCommand): MemoryOutboxSagaV2 {
    return this.store.enqueue(command, this.options.clock());
  }
  get(outboxId: string): MemoryOutboxSagaV2 | undefined { return this.store.get(outboxId); }
  list(input: { readonly state?: string; readonly limit?: number } = {}): readonly MemoryOutboxSagaV2[] {
    return this.store.list(input.state, requireLimit(input.limit ?? 16));
  }
  async runOnce(workerId: string, limit = 16): Promise<MemoryOutboxCycleResult> {
    const worker = requireWorker(workerId); const bound = requireLimit(limit); const result = { ...empty() };
    result.reconciling += this.store.recoverDispatching(this.options.clock());
    for (let index = 0; index < bound; index += 1) {
      const claimed = this.store.claimDispatch(worker, this.options.clock(), this.leaseMs);
      if (claimed === undefined) break;
      result.claimed += 1;
      let dispatch;
      try { dispatch = this.store.markDispatch(claimed.outbox_id, worker, claimed.lease_fence, this.options.clock()); }
      catch (error) { result.failed += 1; if (error instanceof JarvisError) continue; throw error; }
      result.dispatched += 1;
      let outcome;
      try { outcome = await this.options.writer.write(dispatch.request); }
      catch (error) {
        outcome = { kind: "uncertain" as const, code: error instanceof Error ? "MEMORY_OUTBOX_WRITE_FAILED" : "MEMORY_OUTBOX_WRITE_FAILED" };
      }
      this.store.recordResult(dispatch, outcome, this.options.clock()); result.reconciling += 1;
    }
    const reconciled = await this.reconcileOnce(worker, bound);
    return { claimed: result.claimed, dispatched: result.dispatched,
      reconciling: result.reconciling + reconciled.reconciling, settled: reconciled.settled,
      conflicts: reconciled.conflicts, failed: result.failed + reconciled.failed };
  }
  async reconcileOnce(workerId: string, limit = 16): Promise<MemoryOutboxCycleResult> {
    const worker = requireWorker(workerId); const bound = requireLimit(limit); const result = { ...empty() };
    for (let index = 0; index < bound; index += 1) {
      const saga = this.store.claimReconcile(worker, this.options.clock(), this.leaseMs);
      if (saga === undefined) break;
      result.claimed += 1;
      const observation = await this.observe(saga);
      const updated = this.store.recordObservation(saga, observation, this.options.clock());
      if (updated.state === "settled") result.settled += 1;
      else if (updated.state === "conflict") result.conflicts += 1;
      else if (updated.state === "reconciling") result.reconciling += 1;
      else result.failed += 1;
    }
    return result;
  }
  private async observe(saga: MemoryOutboxSagaV2): Promise<MemoryObservation> {
    const dispatched = Date.parse(saga.dispatched_at ?? saga.created_at);
    const elapsed = Math.max(0, this.options.clock().getTime() - dispatched);
    const days = Math.min(365, Math.max(1, Math.ceil(elapsed / 86_400_000) + 1));
    const recent = await this.options.reader.recentChanges(days);
    const expected = saga.expected_artifact;
    if (recent.kind === "conflicts") return this.conflictFrom(recent, expected.page_id);
    const recentEvidence = this.evidence(recent).filter(item => item.page_id === expected.page_id);
    const page = await this.options.reader.readPage(expected.page_id);
    if (page.kind === "conflicts") return this.conflictFrom(page, expected.page_id);
    const pageMatch = this.evidence(page).filter(item =>
      item.page_id === expected.page_id && item.sid === expected.sid);
    const directReplay = pageMatch.filter(item =>
      item.source_ref === `memory-candidate:${saga.candidate_id}`);
    const recentMatch = recentEvidence.length === 0
      ? directReplay
      : recentEvidence.filter(item => item.sid === expected.sid);
    if (recentMatch.length === 0 || pageMatch.length === 0) {
      return { kind: "missing", code: this.readCode(recent, "ARTIFACT_NOT_RECENT") };
    }
    const identities = new Set([...recentMatch, ...pageMatch].map(item => `${item.source_version}\0${item.content_digest}`));
    if (identities.size !== 1 || pageMatch.some(item => item.content_digest !== expected.source_digest)) {
      return { kind: "conflict", code: "ARTIFACT_DIGEST_MISMATCH", page_id: expected.page_id,
        sid: expected.sid, source_version: pageMatch[0]?.source_version, source_digest: pageMatch[0]?.content_digest };
    }
    const matched = pageMatch[0];
    if (matched === undefined) return { kind: "missing", code: "ARTIFACT_SELECTOR_MISSING" };
    return { kind: "match", code: "ARTIFACT_OBSERVED", page_id: matched.page_id, sid: matched.sid,
      source_version: matched.source_version, source_digest: matched.content_digest };
  }
  private evidence(outcome: SecondBrainReadOutcome): readonly SecondBrainEvidence[] {
    return outcome.kind === "current" || outcome.kind === "stale" ? outcome.evidence : [];
  }
  private readCode(outcome: SecondBrainReadOutcome, fallback: string): string {
    return "code" in outcome && typeof outcome.code === "string" ? outcome.code : fallback;
  }
  private conflictFrom(outcome: Extract<SecondBrainReadOutcome, { kind: "conflicts" }>, pageId: string): MemoryObservation {
    const relevant = outcome.conflicts.find(item => item.page_id === pageId || item.left.page_id === pageId || item.right.page_id === pageId);
    return relevant === undefined ? { kind: "missing", code: "ARTIFACT_NOT_RECENT" }
      : { kind: "conflict", code: "ARTIFACT_CONFLICT", page_id: pageId };
  }
}

export type {
  MemoryExpectedArtifactV2,
  MemoryOutboxCycleResult,
  MemoryOutboxSagaV2,
  MemoryOutboxServiceOptions,
  MemoryOutboxStateV2,
} from "./memory-outbox-types.js";
