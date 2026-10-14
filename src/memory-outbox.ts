import { createHash } from "node:crypto";
import { JarvisError } from "./db.js";
import { cleanupMemoryCandidateReviews } from "./memory-candidate-review-cleanup.js";
import { memoryRememberArtifact, observeRememberArtifact } from "./memory-remember-artifact.js";
import { MemoryOutboxStore } from "./memory-outbox-store.js";
import { memoryOutboxControlOutcomes, reconcileMemoryOutboxCommands } from "./memory-outbox-control.js";
import { MemoryOutboxDiagnostics } from "./memory-outbox-diagnostics.js";
import { markMemoryOutboxRecovery, memoryOutboxFailure, memoryOutboxRecoveries, tagMemoryOutboxFailure,
  type MemoryOutboxFailure, type MemoryOutboxPhase } from "./memory-outbox-diagnostic.js";
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
function artifactDigestMatches(item: SecondBrainEvidence, expected: string): boolean {
  if (item.content_digest === expected) return true;
  if (item.record === null || item.excerpt === null) return false;
  const cited = [`${item.excerpt}[^${item.sid}]`, `${item.excerpt} [^${item.sid}]`];
  return cited.some(value => `sha256:${createHash("sha256").update(value).digest("hex")}` === expected);
}
export class MemoryOutboxService {
  private readonly store: MemoryOutboxStore;
  private readonly leaseMs: number;
  private readonly deadlineMs: number;
  private readonly diagnostics: MemoryOutboxDiagnostics;
  constructor(private readonly options: MemoryOutboxServiceOptions) {
    this.leaseMs = requireDuration(options.leaseMs ?? DEFAULT_LEASE_MS);
    this.deadlineMs = requireDuration(options.artifactDeadlineMs ?? MEMORY_OUTBOX_RUNTIME_DEADLINE_MS);
    this.diagnostics = new MemoryOutboxDiagnostics(options.authority);
    this.store = new MemoryOutboxStore(options.authority, this.deadlineMs, {
      candidate_dispatch_spool_root: options.candidate_dispatch_spool_root,
      candidate_review_spool_root: options.candidate_review_spool_root,
    });
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
    const failures: MemoryOutboxFailure[] = [];
    result.reconciling += this.phase("recover_dispatch", () => this.store.recoverDispatching(this.options.clock()));
    for (let index = 0; index < bound; index += 1) {
      const claimed = this.phase("claim_dispatch", () => this.store.claimDispatch(worker, this.options.clock(), this.leaseMs));
      if (claimed === undefined) break;
      result.claimed += 1;
      let dispatch;
      try { dispatch = this.phase("dispatch", () => this.store.markDispatch(claimed.outbox_id, worker, claimed.lease_fence, this.options.clock()), claimed.outbox_id); }
      catch (error) {
        result.failed += 1; failures.push(memoryOutboxFailure(error));
        if (error instanceof JarvisError) continue;
        throw error;
      }
      result.dispatched += 1;
      let outcome;
      try { outcome = await this.options.writer.write(dispatch.request); }
      catch (error) {
        this.diagnostics.record(dispatch.saga.outbox_id,
          memoryOutboxFailure(tagMemoryOutboxFailure("provider_write", error)));
        outcome = { kind: "uncertain" as const, code: "MEMORY_OUTBOX_WRITE_FAILED" };
      }
      this.phase("record_write_result", () => this.store.recordResult(dispatch, outcome, this.options.clock()), dispatch.saga.outbox_id); result.reconciling += 1;
    }
    const reconciled = await this.reconcileOnce(worker, bound);
    const failure = reconciled.failure?.phase === "provider_write" ? reconciled.failure : failures[0] ?? reconciled.failure;
    const cycle = { claimed: result.claimed, dispatched: result.dispatched,
      reconciling: result.reconciling + reconciled.reconciling, settled: reconciled.settled,
      conflicts: reconciled.conflicts, failed: result.failed + reconciled.failed,
      commands_reconciled: reconciled.commands_reconciled ?? 0,
      ...(failure === undefined ? {} : { failure }),
      ...(reconciled.control_error === undefined ? {} : { control_error: reconciled.control_error }),
      ...(reconciled.cleanup_error === undefined ? {} : { cleanup_error: reconciled.cleanup_error }) };
    return markMemoryOutboxRecovery(cycle, memoryOutboxRecoveries(reconciled));
  }
  async reconcileOnce(workerId: string, limit = 16): Promise<MemoryOutboxCycleResult> {
    const worker = requireWorker(workerId); const bound = requireLimit(limit); const result = { ...empty() };
    for (let index = 0; index < bound; index += 1) {
      const saga = this.phase("claim_reconciliation", () => this.store.claimReconcile(worker, this.options.clock(), this.leaseMs));
      if (saga === undefined) break;
      result.claimed += 1;
      try {
        const observation = await this.observe(saga).catch(error => {
          throw tagMemoryOutboxFailure("provider_observation", error);
        });
        this.diagnostics.resolve(saga.outbox_id, "provider_observation");
        const phase = observation.kind === "missing" ? "record_observation" : "settlement";
        const updated = this.phase(phase, () => this.store.recordObservation(saga, observation, this.options.clock()));
        this.diagnostics.resolve(saga.outbox_id, phase);
        if (updated.state === "settled" || updated.state === "conflict") this.diagnostics.resolveOutbox(saga.outbox_id);
        if (updated.state === "settled") result.settled += 1;
        else if (updated.state === "conflict") result.conflicts += 1;
        else if (updated.state === "reconciling") result.reconciling += 1;
        else result.failed += 1;
      } catch (error) {
        const failure = memoryOutboxFailure(error);
        this.diagnostics.record(saga.outbox_id, failure);
        throw error;
      }
    }
    const commands = reconcileMemoryOutboxCommands(this.options.authority, this.options.clock(), bound);
    const outcomes = memoryOutboxControlOutcomes(commands);
    if (outcomes === undefined) {
      if (commands.failure !== undefined) this.diagnostics.recordPhase(commands.failure);
    } else this.diagnostics.resolvePhase("control_reconciliation");
    for (const outcome of outcomes ?? []) {
      if (outcome.failure === undefined) this.diagnostics.resolve(outcome.outbox_id, "control_reconciliation");
      else this.diagnostics.record(outcome.outbox_id, outcome.failure);
    }
    const pending = this.diagnostics.take(bound);
    try { this.cleanupReviews(); }
    catch (error) {
      // Cleanup is retryable on the next cycle. A committed settlement must not
      // become a failed control command merely because local cleanup failed.
      return markMemoryOutboxRecovery({ ...result, ...commands, cleanup_error: "MEMORY_REVIEW_CLEANUP_FAILED" as const,
        failure: pending.failure ?? commands.failure ?? memoryOutboxFailure(tagMemoryOutboxFailure("review_cleanup", error)) },
      pending.retired);
    }
    const failure = pending.failure ?? commands.failure;
    return markMemoryOutboxRecovery({ ...result, ...commands, ...(failure === undefined ? {} : { failure }) }, pending.retired);
  }
  private phase<T>(phase: MemoryOutboxPhase, operation: () => T, outboxId?: string): T {
    const cyclePhase = ["recover_dispatch", "claim_dispatch", "claim_reconciliation"].includes(phase);
    try {
      const result = operation();
      if (outboxId !== undefined) this.diagnostics.resolve(outboxId, phase);
      else if (cyclePhase) this.diagnostics.resolvePhase(phase);
      return result;
    } catch (error) {
      const tagged = tagMemoryOutboxFailure(phase, error); const failure = memoryOutboxFailure(tagged);
      if (outboxId !== undefined) this.diagnostics.record(outboxId, failure);
      else if (cyclePhase) this.diagnostics.recordPhase(failure);
      throw tagged;
    }
  }
  private cleanupReviews(): void {
    const root = this.options.candidate_review_spool_root ?? process.env["JARVIS_MEMORY_REVIEW_SPOOL_ROOT"];
    if (root !== undefined) cleanupMemoryCandidateReviews(this.options.authority, root, this.options.clock());
  }
  private async observe(saga: MemoryOutboxSagaV2): Promise<MemoryObservation> {
    if (saga.operation === "remember" && /^wiki\/memory-[0-9a-f]{64}$/.test(saga.expected_artifact.page_id)) {
      let expectation;
      try { expectation = memoryRememberArtifact(this.store.observationRequest(saga)); }
      catch { return { kind: "missing", code: "MEMORY_OUTBOX_SOURCE_UNAVAILABLE" }; }
      const expected = saga.expected_artifact;
      if (expected.page_id !== expectation.artifact.page_id || expected.sid !== expectation.artifact.sid
        || expected.source_digest !== expectation.artifact.source_digest) {
        return { kind: "conflict", code: "ARTIFACT_DIGEST_MISMATCH", page_id: expected.page_id, sid: expected.sid };
      }
      const page = await this.options.reader.readPage(expected.page_id);
      if (page.kind === "conflicts") return this.conflictFrom(page, expected.page_id);
      if (page.kind !== "current" && page.kind !== "stale") return { kind: "missing", code: this.readCode(page, "ARTIFACT_SELECTOR_MISSING") };
      return observeRememberArtifact(expectation, page.evidence);
    }
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
    const directReplay = pageMatch.filter(item => item.record !== null
      || item.source_ref === `memory-candidate:${saga.candidate_id}`);
    const recentMatch = recentEvidence.length === 0
      ? directReplay
      : recentEvidence.filter(item => item.sid === expected.sid);
    if (recentMatch.length === 0 || pageMatch.length === 0) {
      return { kind: "missing", code: this.readCode(recent, "ARTIFACT_NOT_RECENT") };
    }
    const identities = new Set([...recentMatch, ...pageMatch].map(item => `${item.source_version}\0${item.content_digest}`));
    if (identities.size !== 1 || pageMatch.some(item => !artifactDigestMatches(item, expected.source_digest))) {
      return { kind: "conflict", code: "ARTIFACT_DIGEST_MISMATCH", page_id: expected.page_id,
        sid: expected.sid, source_version: pageMatch[0]?.source_version, source_digest: pageMatch[0]?.content_digest };
    }
    const matched = pageMatch[0];
    if (matched === undefined) return { kind: "missing", code: "ARTIFACT_SELECTOR_MISSING" };
    return { kind: "match", code: "ARTIFACT_OBSERVED", page_id: matched.page_id, sid: matched.sid,
      source_version: matched.source_version, source_digest: expected.source_digest };
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
