import type { AuthorityDb } from "../db.js";
import type { SecondBrainEvidence, SecondBrainReadOutcome } from "../second-brain-adapter-types.js";

export function privateSensitivity(value: string): boolean {
  return value === "sensitive" || value === "restricted";
}

export function sameGeneration(
  evidence: SecondBrainEvidence,
  selection: { readonly provider_instance_id: string; readonly generation_id: string;
    readonly generation_manifest_digest: string; readonly vault_head: string; readonly vault_tree: string;
    readonly tombstone_sequence: number; readonly tombstone_set_root: string },
): boolean {
  const generation = evidence.record?.generation;
  return generation !== undefined
    && generation.provider_instance_id === selection.provider_instance_id
    && generation.generation_id === selection.generation_id
    && generation.generation_manifest_digest === selection.generation_manifest_digest
    && generation.vault_head === selection.vault_head
    && generation.vault_tree === selection.vault_tree
    && generation.tombstone_sequence === selection.tombstone_sequence
    && generation.tombstone_set_root === selection.tombstone_set_root;
}

export function readEvidence(outcome: SecondBrainReadOutcome) {
  switch (outcome.kind) {
    case "current": case "stale": return outcome.evidence;
    case "conflicts": return outcome.conflicts.flatMap(item => [item.left, item.right]);
    case "no_data": case "unavailable": case "offline": case "invalid": return [];
    default: return assertNever(outcome);
  }
}

export function outcomeState(outcome: SecondBrainReadOutcome) {
  switch (outcome.kind) {
    case "current": case "conflicts": return "ready";
    case "stale": return "stale";
    case "no_data": return "no_data";
    case "offline": return "offline";
    case "unavailable": case "invalid": return "unavailable";
    default: return assertNever(outcome);
  }
}

export function outcomeOmissions(outcome: SecondBrainReadOutcome): readonly string[] {
  return outcome.kind === "current" || outcome.kind === "conflicts" ? [] : [outcome.kind];
}

export type MemoryEffectQuery = {
  readonly operation: string; readonly state: string; readonly limit: number;
};
export function listMemoryEffects(authority: AuthorityDb, clock: () => Date, query: MemoryEffectQuery) {
  const attemptStates = surfaceAttemptStates(query.state);
  if (attemptStates !== undefined) {
    const placeholders = attemptStates.map(() => "?").join(",");
    const rows = authority.db.prepare(
      `SELECT a.control_request_id AS request_id,a.updated_at FROM memory_surface_effect_attempts a
       JOIN memory_surface_semantic_families f ON f.family_digest=a.family_digest
       WHERE f.operation=? AND a.state IN (${placeholders})
       ORDER BY a.created_at,a.control_request_id LIMIT ?`,
    ).all(query.operation, ...attemptStates, query.limit) as Array<Record<string, unknown>>;
    return effectPage(clock, { operation: query.operation, uiState: query.state, rows, limit: query.limit });
  }
  const table = query.operation === "correct" ? "memory_correction_requests"
    : query.operation === "forget" ? "memory_deletion_effect_requests" : "memory_export_requests";
  const id = query.operation === "correct" ? "correction_id"
    : query.operation === "forget" ? "deletion_id" : "export_id";
  const rows = authority.db.prepare(
    `SELECT ${id} AS request_id,state,failure_code,created_at,updated_at FROM ${table}
     WHERE state=? ORDER BY created_at,${id} LIMIT ?`,
  ).all(query.state, query.limit) as Array<Record<string, unknown>>;
  return effectPage(clock, { operation: query.operation, uiState: undefined, rows, limit: query.limit });
}

function surfaceAttemptStates(state: string): readonly string[] | undefined {
  switch (state) {
    case "pending_approval": return ["staged"];
    case "applying": return ["approved", "claimed", "reconciling"];
    case "completed": return ["completed"];
    default: return undefined;
  }
}

function effectPage(clock: () => Date, page: {
  readonly operation: string; readonly uiState: string | undefined;
  readonly rows: Array<Record<string, unknown>>; readonly limit: number;
}) {
  return { schema_version: 1, resource: "memory-effects", generated_at: clock().toISOString(),
    state: "ready", items: page.rows.map(row => {
      const displayed = page.uiState ?? String(row["state"]);
      return { request_id: String(row["request_id"]), operation: page.operation, state: displayed,
        failure_code: row["failure_code"] === null || row["failure_code"] === undefined ? null
          : String(row["failure_code"]), updated_at: String(row["updated_at"]),
        proof_state: displayed === "completed" ? "verified" : "pending", export_lifecycle: null };
    }), page: { limit: page.limit, returned: page.rows.length, has_more: page.rows.length === page.limit,
      next_cursor: null } };
}

function assertNever(value: never): never {
  throw new Error(`unexpected memory outcome: ${JSON.stringify(value)}`);
}
