import { candidateTaskSourceClosed } from "../memory-candidate-task-source.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import { isDeepStrictEqual } from "node:util";
import { readCandidateReview } from "./memory-candidate-review.js";
import { memoryRememberProgress } from "./memory-remember-progress.js";
import { memoryReadPrivacyState, isMemoryReadSuppressed } from "../memory-read-privacy.js";
import type { SecondBrainEvidence, SecondBrainReadAdapter } from "../second-brain-adapter-types.js";
import type { DashboardSessionStore } from "./session.js";
import { MemoryTokenCache, type MemoryTokenAuthority } from "./memory-token-cache.js";
import { memoryRecordLineage, type MemoryRecordLineage } from "./memory-record-history.js";
import { projectMemoryRecord } from "./memory-redaction.js";
import { listMemoryEffects, outcomeOmissions, outcomeState, privateSensitivity, readEvidence,
  sameGeneration } from "./memory-read-projection.js";

export type MemoryReadServiceOptions = { readonly authority: AuthorityDb;
  readonly adapter: SecondBrainReadAdapter | undefined; readonly tokens: MemoryTokenCache;
  readonly session: DashboardSessionStore; readonly clock: () => Date;
  readonly candidate_review_spool_root?: string };
type SurfaceAuthoritySnapshot = MemoryTokenAuthority & {
  readonly privacy_epoch: number;
  readonly suppression_sequence: number;
  readonly suppression_root: string;
  readonly tombstone_sequence: number;
  readonly tombstone_set_root: string;
  readonly membership_revision: string;
  readonly read_revision: number;
};
export class MemoryReadService {
  private readonly authority: AuthorityDb; private readonly adapter: SecondBrainReadAdapter | undefined;
  private readonly tokens: MemoryTokenCache; private readonly session: DashboardSessionStore;
  private readonly clock: () => Date;
  constructor(private readonly options: MemoryReadServiceOptions) {
    this.authority = options.authority; this.adapter = options.adapter; this.tokens = options.tokens;
    this.session = options.session; this.clock = options.clock;
  }
  status() {
    const authority = this.surfaceSnapshot();
    const profile = this.adapter?.contract_profile;
    const checkedAt = this.clock();
    return { schema_version: 1, resource: "memory-status", state: this.adapter === undefined ? "unavailable" : "ready",
      privacy_epoch: authority.privacy_epoch, checked_at: checkedAt.toISOString(),
      fresh_until: new Date(checkedAt.getTime() + 60_000).toISOString(),
      contract_schema: this.adapter === undefined ? null : profile === "schema4" ? 4 : 3,
      mutations_enabled: profile === "schema4" };
  }
  async search(query: string, limit: number) {
    const initial = this.surfaceSnapshot(); const now = this.clock();
    if (this.adapter === undefined) return { schema_version: 1, resource: "memory-search",
      generated_at: now.toISOString(), state: "unavailable", query_revision: this.tokens.revision("query",
        this.session.authenticatedSessionId(), query), resource_revision: this.tokens.revision("resource",
        this.session.authenticatedSessionId(), `search\0${String(initial.privacy_epoch)}`),
      privacy_epoch: initial.privacy_epoch, provider_generation: null, items: [], truncated: false,
      omissions: ["provider_unavailable"], checked_at: now.toISOString(), fresh_until: this.freshUntil(now) };
    const outcome = await this.adapter.search(query);
    return this.withStableSurface(initial, final => {
      const allEvidence = readEvidence(outcome);
      // Forgotten records never leave the authority; superseded ones stay as metadata-only history.
      const visible = allEvidence.map(item => ({ item, lineage: this.lineage(item) }))
        .filter(entry => !entry.lineage.forgotten);
      const evidence = visible.slice(0, limit);
      const sessionId = final.owner_session_id!;
      const items = evidence.map(entry => projectMemoryRecord({ evidence: entry.item, tokens: this.tokens,
        sessionId, sessionIncarnation: final.session_incarnation, privacyEpoch: final.privacy_epoch,
        policyDigest: final.policy_digest, now, lineage: entry.lineage }))
        .filter(item => item !== undefined);
      const forgotten = visible.length === 0 && allEvidence.length > 0;
      return { schema_version: 1, resource: "memory-search", generated_at: now.toISOString(),
        state: forgotten ? "no_data" : outcomeState(outcome), query_revision: this.tokens.revision("query", sessionId, query),
        resource_revision: this.tokens.revision("resource", sessionId, `search\0${String(final.privacy_epoch)}\0${final.membership_revision}`),
        privacy_epoch: final.privacy_epoch, provider_generation: evidence[0]?.item.record?.generation.generation_id ?? null,
        items, truncated: evidence.length < visible.length,
        omissions: forgotten ? ["privacy_filtered"] : outcomeOmissions(outcome),
        checked_at: now.toISOString(), fresh_until: this.freshUntil(now) };
    });
  }
  async detail(token: string) {
    const authority = this.surfaceSnapshot(); const sessionId = this.session.authenticatedSessionId();
    const selection = this.tokens.get(token, {
      owner_session_id: sessionId, session_incarnation: authority.session_incarnation,
      privacy_epoch: authority.privacy_epoch, policy_digest: authority.policy_digest,
      tombstone_sequence: authority.tombstone_sequence, tombstone_set_root: authority.tombstone_set_root,
    });
    if (selection === undefined || this.adapter === undefined) return undefined;
    const outcome = await this.adapter.readPage(selection.page_id);
    return this.withStableSurface(authority, final => {
      const evidence = readEvidence(outcome).find(item => item.record?.record_id === selection.record_id
        && item.record.record_digest === selection.record_digest
        && sameGeneration(item, selection));
      const item = evidence === undefined ? undefined : projectMemoryRecord({
        evidence, tokens: this.tokens, sessionId, sessionIncarnation: final.session_incarnation,
        privacyEpoch: final.privacy_epoch, policyDigest: final.policy_digest, now: this.clock(),
        lineage: this.lineage(evidence) });
      return item === undefined ? undefined : { schema_version: 1, resource: "memory-record-detail",
        privacy_epoch: final.privacy_epoch, item, conflicts: [], history: [], effect_counts: { total: 0 } };
    });
  }

  private withStableSurface<T>(initial: SurfaceAuthoritySnapshot,
    project: (final: SurfaceAuthoritySnapshot) => T): T {
    return this.authority.db.transaction(() => {
      const final = this.surfaceSnapshot();
      if (!isDeepStrictEqual(initial, final)) {
        throw new JarvisError("MEMORY_SURFACE_READ_CHANGED");
      }
      return project(final);
    })();
  }

  private surfaceSnapshot(): SurfaceAuthoritySnapshot {
    const state = memoryReadPrivacyState(this.authority);
    const sessionId = this.session.authenticatedSessionId();
    return { ...state, policy_digest: state.policy_digest ?? undefined,
      owner_session_id: sessionId, session_incarnation: sessionId };
  }

  private suppressed(evidence: SecondBrainEvidence): boolean {
    return isMemoryReadSuppressed(this.authority, evidence, (kind, value) => this.tokens.membership(kind, value));
  }

  private lineage(evidence: SecondBrainEvidence): MemoryRecordLineage {
    return memoryRecordLineage(this.authority, evidence, (kind, value) => this.tokens.membership(kind, value));
  }

  private freshUntil(now: Date): string { return new Date(now.getTime() + 60_000).toISOString(); }
  candidates(state: string, limit: number) {
    const rows = this.authority.db.prepare(
      `SELECT c.candidate_id,c.candidate_kind,c.operation,c.sensitivity,c.state,c.expires_at,c.created_at,
       m.confidence,m.retention_days,m.classification_reason,m.conflict_state,m.policy_sensitivity,
       EXISTS(SELECT 1 FROM memory_candidate_dispatch_publications p
         WHERE p.candidate_id=c.candidate_id AND p.state='published') AS published,
       EXISTS(SELECT 1 FROM control_command_requests r WHERE r.action='memory.outbox.dispatch'
         AND json_extract(r.target_json,'$.candidate_id')=c.candidate_id) AS dispatched
       FROM memory_candidates c JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
       WHERE c.state=? AND c.expires_at>?
         AND (c.state<>'awaiting_confirmation' OR c.confirmation_expires_at>?)
         AND (c.state<>'approved' OR (
           EXISTS(SELECT 1 FROM memory_candidate_dispatch_publications p
             WHERE p.candidate_id=c.candidate_id AND p.state='published')
           AND NOT EXISTS(SELECT 1 FROM control_command_requests r WHERE r.action='memory.outbox.dispatch'
             AND json_extract(r.target_json,'$.candidate_id')=c.candidate_id)))
       ORDER BY c.created_at,c.candidate_id LIMIT ?`,
    ).all(state, this.clock().toISOString(), this.clock().toISOString(), limit) as Array<Record<string, unknown>>;
    // The list is a read of derived memory, so it asks what every other consumption asks: is the
    // task this candidate came from closed to us, by the owner hiding it or by its project falling
    // outside the list they wrote. The policy is not something SQL can join against, so it is
    // applied here, over the rows the query returned.
    const visible = rows.filter(row =>
      !candidateTaskSourceClosed(this.authority, String(row["candidate_id"])));
    return { schema_version: 1, resource: "memory-candidates", generated_at: this.clock().toISOString(),
      state: "ready", items: visible.map(row => ({ candidate_id: String(row["candidate_id"]),
        candidate_revision: this.tokens.revision("candidate", this.session.authenticatedSessionId(),
          String(row["candidate_id"])), kind: String(row["candidate_kind"]), operation: String(row["operation"]),
        confidence: String(row["confidence"]), sensitivity: String(row["policy_sensitivity"]),
        retention: { source: "policy", days: Number(row["retention_days"]) },
        expires_at: String(row["expires_at"]), reason: String(row["classification_reason"]),
        conflict: String(row["conflict_state"]), provenance: "JARVIS candidate source",
        review_state: "unavailable", actions: row["operation"] !== "remember" ? []
          : state === "awaiting_confirmation" && !privateSensitivity(String(row["sensitivity"]))
            && this.options.candidate_review_spool_root !== undefined ? ["inspect"]
            : state === "approved" && row["published"] === 1 && row["dispatched"] === 0
              ? ["stage_dispatch"] : [] })), page: { limit, returned: rows.length,
        has_more: rows.length === limit, next_cursor: null } };
  }
  effects(operation: string, state: string, limit: number) {
    return listMemoryEffects(this.authority, this.clock, { operation, state, limit });
  }
  rememberProgress(limit: number) { return memoryRememberProgress(this.authority, this.clock(), limit); }
  candidate(candidateId: string) {
    return readCandidateReview(this.authority, this.options.candidate_review_spool_root,
      candidateId, this.clock());
  }
  effect(requestId: string) {
    for (const operation of ["correct", "forget", "export"] as const) {
      for (const state of ["approved", "queued", "reconciling", "available", "settled"] as const) {
        const found = this.effects(operation, state, 100).items.find(item => item.request_id === requestId);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }
  async conflicts(limit: number) {
    const initial = this.surfaceSnapshot();
    if (this.adapter === undefined) return { schema_version: 1, resource: "memory-conflicts",
      generated_at: this.clock().toISOString(), state: "unavailable", privacy_epoch: initial.privacy_epoch,
      items: [], truncated: false };
    const outcome = await this.adapter.openConflicts();
    return this.withStableSurface(initial, final => {
      const visible = outcome.kind === "conflicts" ? outcome.conflicts.filter(item =>
        !this.suppressed(item.left) && !this.suppressed(item.right)) : [];
      const conflicts = visible.slice(0, limit);
      return { schema_version: 1, resource: "memory-conflicts", generated_at: this.clock().toISOString(),
        state: outcome.kind === "conflicts" && visible.length === 0 ? "no_data" : outcomeState(outcome),
        privacy_epoch: initial.privacy_epoch, items: conflicts.map(item => ({
          conflict_revision: this.tokens.revision("resource", final.owner_session_id!, item.conflict_id),
          subject: privateSensitivity(item.left.sensitivity) || privateSensitivity(item.right.sensitivity)
            ? "[REDACTED]" : "Unresolved memory conflict", state: item.state,
          sides: [item.left, item.right].map(side => ({ sensitivity: side.sensitivity,
            citation: privateSensitivity(side.sensitivity) ? "Private citation" : "Memory citation" })) })),
        truncated: conflicts.length < visible.length };
    });
  }
}
