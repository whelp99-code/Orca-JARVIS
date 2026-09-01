import type { AuthorityDb } from "../db.js";
import type { SecondBrainReadAdapter, SecondBrainReadOutcome } from "../second-brain-adapter-types.js";
import type { DashboardSessionStore } from "./session.js";
import { MemoryTokenCache } from "./memory-token-cache.js";
import { projectMemoryRecord } from "./memory-redaction.js";

export type MemoryReadServiceOptions = { readonly authority: AuthorityDb;
  readonly adapter: SecondBrainReadAdapter | undefined; readonly tokens: MemoryTokenCache;
  readonly session: DashboardSessionStore; readonly clock: () => Date };
export class MemoryReadService {
  private readonly authority: AuthorityDb; private readonly adapter: SecondBrainReadAdapter | undefined;
  private readonly tokens: MemoryTokenCache; private readonly session: DashboardSessionStore;
  private readonly clock: () => Date;
  constructor(options: MemoryReadServiceOptions) {
    this.authority = options.authority; this.adapter = options.adapter; this.tokens = options.tokens;
    this.session = options.session; this.clock = options.clock;
  }
  status() {
    const row = this.authority.db.prepare("SELECT privacy_epoch FROM memory_surface_authority WHERE singleton_id=1")
      .get() as { readonly privacy_epoch: number };
    return { schema_version: 1, resource: "memory-status", state: this.adapter === undefined ? "unavailable" : "ready",
      privacy_epoch: row.privacy_epoch, checked_at: this.clock().toISOString(),
      fresh_until: new Date(this.clock().getTime() + 60_000).toISOString(),
      contract_schema: this.adapter === undefined ? null : 4, mutations_enabled: this.adapter !== undefined };
  }
  async search(query: string, limit: number) {
    const status = this.status(); const now = this.clock();
    if (this.adapter === undefined) return { schema_version: 1, resource: "memory-search",
      generated_at: now.toISOString(), state: "unavailable", query_revision: this.tokens.revision("query",
        this.session.authenticatedSessionId(), query), resource_revision: this.tokens.revision("resource",
        this.session.authenticatedSessionId(), `search\0${String(status.privacy_epoch)}`),
      privacy_epoch: status.privacy_epoch, provider_generation: null, items: [], truncated: false,
      omissions: ["provider_unavailable"], checked_at: now.toISOString(), fresh_until: status.fresh_until };
    const outcome = await this.adapter.search(query);
    const evidence = readEvidence(outcome).slice(0, limit);
    const items = evidence.map(item => projectMemoryRecord({ evidence: item, tokens: this.tokens,
      sessionId: this.session.authenticatedSessionId(), privacyEpoch: status.privacy_epoch, now }))
      .filter(item => item !== undefined);
    return { schema_version: 1, resource: "memory-search", generated_at: now.toISOString(),
      state: outcomeState(outcome), query_revision: this.tokens.revision("query",
        this.session.authenticatedSessionId(), query), resource_revision: this.tokens.revision("resource",
        this.session.authenticatedSessionId(), `search\0${String(status.privacy_epoch)}`),
      privacy_epoch: status.privacy_epoch, provider_generation: evidence[0]?.record?.generation.generation_id ?? null,
      items, truncated: evidence.length < readEvidence(outcome).length, omissions: outcomeOmissions(outcome),
      checked_at: now.toISOString(), fresh_until: status.fresh_until };
  }
  async detail(token: string) {
    const status = this.status(); const sessionId = this.session.authenticatedSessionId();
    const selection = this.tokens.get(token, sessionId, status.privacy_epoch);
    if (selection === undefined || this.adapter === undefined) return undefined;
    const outcome = await this.adapter.readPage(selection.page_id);
    const evidence = readEvidence(outcome).find(item => item.record?.record_id === selection.record_id
      && item.record.record_digest === selection.record_digest);
    const item = evidence === undefined ? undefined : projectMemoryRecord({ evidence, tokens: this.tokens,
      sessionId, privacyEpoch: status.privacy_epoch, now: this.clock() });
    return item === undefined ? undefined : { schema_version: 1, resource: "memory-record-detail",
      privacy_epoch: status.privacy_epoch, item, conflicts: [], history: [], effect_counts: { total: 0 } };
  }
  candidates(state: string, limit: number) {
    const rows = this.authority.db.prepare(
      `SELECT c.candidate_id,c.candidate_kind,c.operation,c.sensitivity,c.state,c.expires_at,c.created_at,
       m.confidence,m.retention_days,m.classification_reason,m.conflict_state
       FROM memory_candidates c JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
       WHERE c.state=? ORDER BY c.created_at,c.candidate_id LIMIT ?`,
    ).all(state, limit) as Array<Record<string, unknown>>;
    return { schema_version: 1, resource: "memory-candidates", generated_at: this.clock().toISOString(),
      state: "ready", items: rows.map(row => ({ candidate_id: String(row["candidate_id"]),
        candidate_revision: this.tokens.revision("candidate", this.session.authenticatedSessionId(),
          String(row["candidate_id"])), kind: String(row["candidate_kind"]), operation: String(row["operation"]),
        confidence: String(row["confidence"]), sensitivity: String(row["sensitivity"]),
        retention: { source: "policy", days: Number(row["retention_days"]) },
        expires_at: String(row["expires_at"]), reason: String(row["classification_reason"]),
        conflict: String(row["conflict_state"]), provenance: "Verified JARVIS authority",
        review_state: "unavailable", actions: [] })), page: { limit, returned: rows.length,
        has_more: rows.length === limit, next_cursor: null } };
  }
  effects(operation: string, state: string, limit: number) {
    const table = operation === "correct" ? "memory_correction_requests"
      : operation === "forget" ? "memory_deletion_effect_requests" : "memory_export_requests";
    const id = operation === "correct" ? "correction_id" : operation === "forget" ? "deletion_id" : "export_id";
    const rows = this.authority.db.prepare(
      `SELECT ${id} AS request_id,state,failure_code,created_at,updated_at FROM ${table}
       WHERE state=? ORDER BY created_at,${id} LIMIT ?`,
    ).all(state, limit) as Array<Record<string, unknown>>;
    return { schema_version: 1, resource: "memory-effects", generated_at: this.clock().toISOString(),
      state: "ready", items: rows.map(row => ({ request_id: String(row["request_id"]), operation,
        state: String(row["state"]), failure_code: row["failure_code"] === null ? null
          : String(row["failure_code"]), updated_at: String(row["updated_at"]), proof_state: "pending",
        export_lifecycle: null })), page: { limit, returned: rows.length,
        has_more: rows.length === limit, next_cursor: null } };
  }
  candidate(candidateId: string) {
    const page = this.candidates("awaiting_confirmation", 100);
    return page.items.find(item => item.candidate_id === candidateId);
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
    const status = this.status();
    if (this.adapter === undefined) return { schema_version: 1, resource: "memory-conflicts",
      generated_at: this.clock().toISOString(), state: "unavailable", privacy_epoch: status.privacy_epoch,
      items: [], truncated: false };
    const outcome = await this.adapter.openConflicts();
    const conflicts = outcome.kind === "conflicts" ? outcome.conflicts.slice(0, limit) : [];
    return { schema_version: 1, resource: "memory-conflicts", generated_at: this.clock().toISOString(),
      state: outcomeState(outcome), privacy_epoch: status.privacy_epoch, items: conflicts.map(item => ({
        conflict_revision: this.tokens.revision("resource", this.session.authenticatedSessionId(), item.conflict_id),
        subject: privateSensitivity(item.left.sensitivity) || privateSensitivity(item.right.sensitivity)
          ? "[REDACTED]" : "Unresolved memory conflict", state: item.state,
        sides: [item.left, item.right].map(side => ({ sensitivity: side.sensitivity,
          citation: privateSensitivity(side.sensitivity) ? "Private citation" : "Memory citation" })) })),
      truncated: conflicts.length < (outcome.kind === "conflicts" ? outcome.conflicts.length : 0) };
  }
}
function privateSensitivity(value: string): boolean { return value === "sensitive" || value === "restricted"; }
function readEvidence(outcome: SecondBrainReadOutcome) {
  switch (outcome.kind) {
    case "current": case "stale": return outcome.evidence;
    case "conflicts": return outcome.conflicts.flatMap(item => [item.left, item.right]);
    case "no_data": case "unavailable": case "offline": case "invalid": return [];
    default: return assertNever(outcome);
  }
}
function outcomeState(outcome: SecondBrainReadOutcome) {
  switch (outcome.kind) {
    case "current": case "conflicts": return "ready";
    case "stale": return "stale";
    case "no_data": return "no_data";
    case "offline": return "offline";
    case "unavailable": case "invalid": return "unavailable";
    default: return assertNever(outcome);
  }
}
function outcomeOmissions(outcome: SecondBrainReadOutcome): readonly string[] {
  return outcome.kind === "current" || outcome.kind === "conflicts" ? [] : [outcome.kind];
}
function assertNever(value: never): never { throw new Error(`unexpected memory outcome: ${JSON.stringify(value)}`); }
