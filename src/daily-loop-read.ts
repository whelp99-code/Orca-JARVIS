import type { AuthorityDb } from "./db.js";
import { assertDailyLoopIntegrity } from "./daily-loop-integrity.js";
import { parseDailyLoopInstant, parseDailyLoopRunId } from "./daily-loop-input.js";
import { DailyLoopError, type DailyLoopStep } from "./daily-loop-types.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";

type Row = Readonly<Record<string, unknown>>;

export class DailyLoopReadStore {
  constructor(private readonly authority: AuthorityDb) {}

  due(atValue: unknown): readonly string[] {
    const at = parseDailyLoopInstant(atValue);
    const rows = this.authority.db.prepare(
      `SELECT run_id FROM daily_loop_runs WHERE state='pending'
       AND ((record_version=1 AND not_before<=?) OR (record_version=0 AND created_at<=?))
       AND ?<expires_at ORDER BY not_before,run_id`,
    ).all(at.toISOString(), at.toISOString(), at.toISOString()) as Row[];
    const candidates = rows.map(row => String(row["run_id"]));
    const runIds = projectionAuthorityReady(this.authority)
      ? new MemoryProjectionAuthority(this.authority).visible(candidates, runId => ({
        kind: "daily_run", id: runId, component_id: runId,
      }))
      : candidates;
    for (const runId of runIds) assertDailyLoopIntegrity(this.authority, runId);
    return runIds;
  }

  steps(runIdValue: unknown): readonly DailyLoopStep[] {
    const runId = parseDailyLoopRunId(runIdValue);
    const projections = projectionAuthorityReady(this.authority)
      ? new MemoryProjectionAuthority(this.authority) : null;
    if (projections?.isSuppressed({ kind: "daily_run", id: runId, component_id: runId })) return [];
    assertDailyLoopIntegrity(this.authority, runId);
    const rows = this.authority.db.prepare(
      "SELECT step_id,sequence,step_key,state FROM daily_loop_steps WHERE run_id=? ORDER BY sequence",
    ).all(runId) as Row[];
    const visible = projections?.visible(rows, row => ({
      kind: "daily_step", id: String(row["step_id"]), component_id: String(row["step_id"]),
    })) ?? rows;
    return visible.map(row => ({ step_id: String(row["step_id"]),
      sequence: Number(row["sequence"]), step_key: String(row["step_key"]),
      state: this.stepState(row["state"]) }));
  }

  private stepState(value: unknown): DailyLoopStep["state"] {
    switch (value) {
      case "pending": case "claimed": case "running": case "verifying": case "completed":
      case "failed": case "uncertain":
        return value;
      default:
        throw new DailyLoopError("DAILY_LOOP_IDENTITY_CONFLICT");
    }
  }
}

function projectionAuthorityReady(authority: AuthorityDb): boolean {
  return authority.db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_projection_authority'",
  ).get() !== undefined;
}
