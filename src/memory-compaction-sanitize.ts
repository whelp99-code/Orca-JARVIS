import type Database from "better-sqlite3";

export type SuppressedProjection = {
  readonly kind: string;
  readonly id: string;
  readonly component_id: string;
};

const CONTENT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  context: ["canonical_envelope_json", "declared_query"],
  recommendation: ["canonical_envelope_json"],
  recommendation_action: ["title"],
  observation: ["canonical_envelope_json"],
  daily_run: ["input_json"],
  daily_step: ["detail_json"],
  morning_brief: ["detail_json"],
  evening_closeout: ["detail_json"],
  notification_intent: ["redacted_preview", "deep_link"],
  control_payload: ["target_json", "args_json"],
  restore_control: ["target_json", "args_json"],
} as const;

export function suppressedProjections(database: Database.Database): readonly SuppressedProjection[] {
  return database.prepare(
    `SELECT DISTINCT projection_kind AS kind,projection_id AS id,component_id
     FROM memory_projection_suppressions ORDER BY projection_kind,projection_id,component_id`,
  ).all().flatMap(value => {
    if (value === null || typeof value !== "object") return [];
    const kind = Reflect.get(value, "kind");
    const id = Reflect.get(value, "id");
    const component = Reflect.get(value, "component_id");
    return typeof kind === "string" && typeof id === "string" && typeof component === "string"
      ? [{ kind, id, component_id: component }] : [];
  });
}

export function collectSuppressedContent(
  database: Database.Database,
  projections: readonly SuppressedProjection[],
): Buffer[] {
  const material: Buffer[] = [];
  for (const projection of projections) {
    const selection = selectionFor(projection);
    if (selection === undefined) continue;
    const columns = CONTENT_COLUMNS[projection.kind] ?? [];
    if (columns.length === 0) continue;
    const rows = database.prepare(
      `SELECT ${columns.map(quote).join(",")} FROM ${quote(selection.table)} WHERE ${selection.where}`,
    ).all(...selection.params);
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      for (const column of columns) {
        const value = Reflect.get(row, column);
        if (typeof value === "string" && value.length > 0) {
          const structured = projection.kind === "outbox" || projection.kind === "control_payload"
            || projection.kind === "restore_control";
          const content = structured ? requestContent(value) : undefined;
          if (content !== undefined) material.push(Buffer.from(content));
          else if (!structured) material.push(Buffer.from(value));
        } else if (Buffer.isBuffer(value) && value.byteLength > 0) material.push(Buffer.from(value));
      }
    }
  }
  return material;
}

function requestContent(encoded: string): string | undefined {
  const parsed: unknown = JSON.parse(encoded);
  if (parsed === null || typeof parsed !== "object") return undefined;
  const nested = Reflect.get(parsed, "request");
  const request = nested !== null && typeof nested === "object" ? nested : parsed;
  const payload = Reflect.get(request, "payload");
  if (payload === null || typeof payload !== "object") return undefined;
  const content = Reflect.get(payload, "content");
  return typeof content === "string" && content.length > 0 ? content : undefined;
}

export function removeSuppressedRows(
  database: Database.Database,
  projections: readonly SuppressedProjection[],
): void {
  for (const projection of projections) {
    for (const statement of deleteStatements(projection)) database.prepare(statement.sql).run(...statement.params);
  }
}

type Selection = {
  readonly table: string;
  readonly where: string;
  readonly params: readonly string[];
};

type DeleteStatement = {
  readonly sql: string;
  readonly params: readonly string[];
};

function selectionFor(projection: SuppressedProjection): Selection | undefined {
  switch (projection.kind) {
    case "context": return { table: "personal_context_snapshots", where: "context_id=?", params: [projection.id] };
    case "recommendation": return { table: "personal_recommendations", where: "recommendation_id=?", params: [projection.id] };
    case "recommendation_action": return { table: "personal_recommendation_actions",
      where: "recommendation_id=? AND CAST(rank AS TEXT)=?", params: [projection.id, projection.component_id] };
    case "observation": return { table: "personal_observations", where: "observation_id=?", params: [projection.id] };
    case "daily_run": return { table: "daily_loop_runs", where: "run_id=?", params: [projection.id] };
    case "daily_step": case "morning_brief": case "evening_closeout":
      return { table: "daily_loop_steps", where: "step_id=?", params: [projection.id] };
    case "notification_intent": return { table: "notification_intents", where: "intent_id=?", params: [projection.id] };
    case "control_payload": return { table: "control_command_requests", where: "request_id=?", params: [projection.id] };
    case "candidate": return { table: "memory_candidate_verification_authority",
      where: "candidate_id=?", params: [projection.id] };
    case "outbox": return { table: "memory_outbox", where: "outbox_id=?", params: [projection.id] };
    case "restore_control": return { table: "control_command_requests",
      where: "request_id=?", params: [projection.id] };
    default: return undefined;
  }
}

function deleteStatements(projection: SuppressedProjection): readonly DeleteStatement[] {
  switch (projection.kind) {
    case "notification_intent": return [
      statement("DELETE FROM notification_deliveries WHERE intent_id=?", projection.id),
      statement("DELETE FROM notification_intents WHERE intent_id=?", projection.id),
    ];
    case "recommendation": return [
      statement("DELETE FROM personal_recommendation_action_events WHERE recommendation_id=?", projection.id),
      statement("DELETE FROM personal_recommendation_actions WHERE recommendation_id=?", projection.id),
      statement("DELETE FROM personal_recommendation_evidence WHERE recommendation_id=?", projection.id),
      statement("DELETE FROM personal_recommendations WHERE recommendation_id=?", projection.id),
    ];
    case "context": return [
      statement("DELETE FROM personal_context_observations WHERE context_id=?", projection.id),
      statement("DELETE FROM personal_context_memory_evidence WHERE context_id=?", projection.id),
      statement("DELETE FROM personal_context_evidence WHERE context_id=?", projection.id),
      statement("DELETE FROM personal_context_snapshots WHERE context_id=?", projection.id),
    ];
    case "daily_run": return [
      statement("DELETE FROM daily_loop_checkpoints WHERE run_id=?", projection.id),
      statement("DELETE FROM daily_loop_steps WHERE run_id=?", projection.id),
      statement("DELETE FROM daily_loop_runs WHERE run_id=?", projection.id),
    ];
    case "daily_step": case "morning_brief": case "evening_closeout":
      return [statement("DELETE FROM daily_loop_checkpoints WHERE step_id=?", projection.id),
        statement("DELETE FROM daily_loop_steps WHERE step_id=?", projection.id)];
    case "observation": return [
      statement("DELETE FROM personal_source_checkpoints WHERE observation_id=?", projection.id),
      statement("DELETE FROM personal_observations WHERE observation_id=?", projection.id),
    ];
    case "control_payload": case "restore_control": return [statement(
      `UPDATE control_command_requests SET target_json='{"purged":true}',
       args_json='{"purged":true}' WHERE request_id=?`, projection.id,
    )];
    case "outbox": return [
      statement("DELETE FROM memory_scoped_settlements WHERE outbox_id=?", projection.id),
      statement("DELETE FROM memory_scoped_completion_observations WHERE outbox_id=?", projection.id),
      statement("DELETE FROM memory_scoped_outbox_bindings WHERE outbox_id=?", projection.id),
      statement("DELETE FROM memory_outbox_control_cursor WHERE last_outbox_id=?", projection.id),
      statement("DELETE FROM memory_reconciliation_events WHERE outbox_id=?", projection.id),
      statement("DELETE FROM memory_outbox_attempts WHERE outbox_id=?", projection.id),
      statement("DELETE FROM memory_outbox WHERE outbox_id=?", projection.id),
    ];
    case "candidate": return [
      statement("DELETE FROM memory_candidate_authority_claims WHERE candidate_id=?", projection.id),
      statement("DELETE FROM memory_candidate_verification_authority WHERE candidate_id=?", projection.id),
      statement("DELETE FROM memory_candidate_source_refs WHERE candidate_id=?", projection.id),
      statement("DELETE FROM memory_candidate_idempotency WHERE candidate_id=?", projection.id),
      statement("DELETE FROM memory_candidate_classifications WHERE candidate_id=?", projection.id),
      statement("DELETE FROM memory_candidates WHERE candidate_id=?", projection.id),
    ];
    default: return [];
  }
}

function statement(sql: string, ...params: string[]): DeleteStatement {
  return { sql, params };
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
