import type { AuthorityDb } from "./db.js";
import { assertDailyLoopIntegrity } from "./daily-loop-integrity.js";
import { parseStoreClaim } from "./daily-loop-store-input.js";
import { DailyLoopError, type DailyLoopClaim } from "./daily-loop-types.js";

type Row = Record<string, unknown>;
const terminal = new Set(["completed", "failed", "uncertain"]);

// Supplying a recovery window enables automatic dispatch policy. Manual claims retain their contract.
export function claimDailyLoop(authority: AuthorityDb, value: unknown, recoveryWindowMs?: number): DailyLoopClaim {
  const input = parseStoreClaim(value); const at = input.at.toISOString();
  if (recoveryWindowMs !== undefined && (!Number.isSafeInteger(recoveryWindowMs) || recoveryWindowMs < 0 || recoveryWindowMs > 2_592_000_000)) {
    throw new DailyLoopError("DAILY_LOOP_CONFIG_INVALID");
  }
  const result = authority.db.transaction(() => {
    assertDailyLoopIntegrity(authority, input.run_id);
    const row = authority.db.prepare(
      "SELECT state,lease_owner,lease_fence,lease_expires_at,expires_at,not_before,record_version,phase,created_at " +
      "FROM daily_loop_runs WHERE run_id=?",
    ).get(input.run_id) as Row | undefined;
    if (row === undefined || terminal.has(String(row["state"]))) throw new DailyLoopError("DAILY_LOOP_TERMINAL");
    if (recoveryWindowMs !== undefined && row["state"] === "pending" && (row["phase"] === "morning" || row["phase"] === "evening")) {
      const scheduled = Date.parse(String(row[Number(row["record_version"]) === 1 ? "not_before" : "created_at"]));
      if (input.at.getTime() - scheduled > recoveryWindowMs) {
        authority.db.prepare("UPDATE daily_loop_runs SET state='failed',failure_code='MISSED_RECOVERY_WINDOW',updated_at=? WHERE run_id=?")
          .run(at, input.run_id);
        return null;
      }
    }
    const deadline = Date.parse(String(row["expires_at"]));
    if (input.at.getTime() >= deadline) {
      if (recoveryWindowMs !== undefined) return null;
      throw new DailyLoopError("DAILY_LOOP_STALE_LEASE");
    }
    if (row["lease_owner"] !== null && Date.parse(String(row["lease_expires_at"])) > input.at.getTime()) {
      throw new DailyLoopError("DAILY_LOOP_LEASE_ACTIVE");
    }
    const leaseExpires = new Date(Math.min(input.at.getTime() + input.lease_ms, deadline)).toISOString();
    const fence = Number(row["lease_fence"]);
    const changed = fence === 0
      ? authority.db.prepare(
        "UPDATE daily_loop_runs SET state='claimed',lease_owner=?,lease_fence=1,lease_expires_at=?,updated_at=? " +
        "WHERE run_id=? AND state='pending' AND lease_fence=0 AND (record_version=0 OR not_before<=?) AND ?<expires_at",
      ).run(input.owner_id, leaseExpires, at, input.run_id, at, at)
      : authority.db.prepare(
        "UPDATE daily_loop_runs SET lease_owner=?,lease_fence=lease_fence+1,lease_expires_at=?,updated_at=? " +
        "WHERE run_id=? AND state=? AND lease_fence=? AND lease_owner IS ? AND lease_expires_at<=? AND ?<expires_at",
      ).run(input.owner_id, leaseExpires, at, input.run_id, row["state"], fence, row["lease_owner"], at, at);
    if (changed.changes !== 1) throw new DailyLoopError("DAILY_LOOP_LEASE_ACTIVE");
    const claimed = authority.db.prepare(
      "SELECT lease_fence,lease_expires_at,expires_at FROM daily_loop_runs WHERE run_id=? AND lease_owner=?",
    ).get(input.run_id, input.owner_id) as Row;
    return {
      run_id: input.run_id, owner_id: input.owner_id, fence: Number(claimed["lease_fence"]),
      lease_expires_at: String(claimed["lease_expires_at"]), deadline_at: String(claimed["expires_at"]),
    };
  }).immediate();
  // Omission must commit before the dispatcher skips this run.
  if (result === null) throw new DailyLoopError("DAILY_LOOP_TERMINAL");
  return result;
}
