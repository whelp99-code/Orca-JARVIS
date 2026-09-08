import { canonicalize } from "./canonical.js";
import { closedArray, closedObject, closeoutDigest, closeoutInteger } from "./evening-closeout-parse-values.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { readControlCommand } from "./control-command-read.js";
import { parseDailyLoopDate, parseDailyLoopInstant } from "./daily-loop-input.js";
import { kstInstant, kstLocalDate } from "./daily-loop-time.js";
import { parseTaskExecutionPlan } from "./task-execution-plan.js";
import { readTaskCompletionEvidence } from "./task-completion-evidence.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";

export type NativeEveningSourceConfig = { readonly repository_identities: readonly string[]; readonly max_records: number; readonly max_bytes: number };
type SourceOptions = NativeEveningSourceConfig & { readonly local_date: string; readonly observed_at: Date };
const invalid = (): never => { throw new JarvisError("TASK_COMPLETION_INVALID"); };

export function parseNativeEveningSourceConfig(value: unknown): NativeEveningSourceConfig {
  try {
    const config = closedObject(value, ["repository_identities", "max_records", "max_bytes"]);
    const scopes = closedArray(config.repository_identities, 100).map(closeoutDigest);
    if (new Set(scopes).size !== scopes.length) return invalid();
    return Object.freeze({ repository_identities: Object.freeze(scopes),
      max_records: closeoutInteger(config.max_records, 1, 100),
      max_bytes: closeoutInteger(config.max_bytes, 1, 1048576) });
  } catch { return invalid(); }
}

/** Internal configured source; callers must not treat a user-supplied allowlist as authorization. */
export function readEveningNativeSource(authority: AuthorityDb, value: SourceOptions) {
  if (!value || Object.keys(value).sort().join(",") !== "local_date,max_bytes,max_records,observed_at,repository_identities") return invalid();
  const config = parseNativeEveningSourceConfig({ repository_identities: value.repository_identities,
    max_records: value.max_records, max_bytes: value.max_bytes });
  const date = parseDailyLoopDate(value.local_date); const at = parseDailyLoopInstant(value.observed_at);
  const scopes = config.repository_identities; const { max_records: maxRecords, max_bytes: maxBytes } = config;
  const start = kstInstant(date, 0, 0); const end = new Date(start.getTime() + 86400000);
  if (kstLocalDate(at) < date) return invalid();
  return authority.db.transaction(() => {
    const projections = new MemoryProjectionAuthority(authority); projections.assertReady();
    const rows = scopes.length === 0 ? [] : authority.db.prepare(`SELECT c.request_id,c.run_id,c.completion_id,c.publication_id,
      p.verification_id,json_extract(c.payload_json,'$.artifact_id') AS artifact_id FROM task_completions c
      JOIN task_git_publications p ON p.publication_id=c.publication_id
      WHERE c.created_at>=? AND c.created_at<? AND c.created_at<=?
      AND json_extract(p.binding_json,'$.repository_identity') IN (${scopes.map(() => "?").join(",")})
      ORDER BY c.created_at DESC,c.request_id DESC LIMIT 101`)
      .all(start.toISOString(), end.toISOString(), at.toISOString(), ...scopes) as Array<{
        request_id: string; run_id: string; completion_id: string; publication_id: string; verification_id: string; artifact_id: string }>;
    const records: NonNullable<ReturnType<typeof readTaskCompletionEvidence>>[] = [];
    let bytes = 0; let hidden = 0; let limited = rows.length > 100;
    for (const row of rows.slice(0, 100)) {
      if (records.length >= maxRecords) { limited = true; break; }
      if ([row.request_id, row.run_id, row.completion_id, row.publication_id, row.verification_id, row.artifact_id]
        .some(id => typeof id === "string" && projections.isProjectionIdSuppressed(id))) { hidden++; continue; }
      const command = readControlCommand(authority, row.request_id);
      if (!command) { hidden++; continue; }
      const plan = parseTaskExecutionPlan(command.args.plan);
      if (command.action !== "task.execute" || plan.schema_version !== 2
        || !scopes.includes(plan.publication.repository_identity)) return invalid();
      const evidence = readTaskCompletionEvidence(authority, row.request_id, at);
      if (!evidence || evidence.completion.command_digest !== command.command_digest
        || evidence.completion.run_id !== plan.run_id || evidence.proof.request.task_id !== plan.task_id
        || kstLocalDate(new Date(evidence.completion.completed_at)) !== date) return invalid();
      const ids = [evidence.completion.completion_id, evidence.completion.run_id, evidence.completion.artifact_id,
        evidence.completion.verification_id, evidence.completion.publication_id];
      if (ids.some(id => projections.isProjectionIdSuppressed(id))) { hidden++; continue; }
      const size = Buffer.byteLength(canonicalize(evidence), "utf8");
      if (bytes + size > maxBytes) { limited = true; break; }
      records.push(evidence); bytes += size;
    }
    return { schema_version: 1 as const, local_date: date, observed_at: at.toISOString(),
      state: limited || hidden > 0 ? "partial" as const : records.length === 0 ? "no_data" as const : "ready" as const,
      records, evidence_bytes: bytes, hidden_count: hidden, limited };
  }).deferred();
}
