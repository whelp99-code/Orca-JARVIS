import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { commandNow, type CliCommandContext } from "./cli-command-context.js";
import { DailyLoopError, type DailyLoopConfig } from "./daily-loop-types.js";
import { createStoredMorningDailyLoop } from "./daily-loop-morning-execution.js";
import { dailyLoopUsage } from "./daily-loop-usage.js";
import { kstLocalDate } from "./daily-loop-time.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { assertDailyLoopIntegrity } from "./daily-loop-integrity.js";
import { verifyMorningBriefResult } from "./morning-brief-artifact.js";
import { executeEveningCommand } from "./cli-evening-command.js";
import { parseTrustedCloseoutKey } from "./evening-closeout-crypto.js";
import type { TrustedCloseoutKey } from "./evening-closeout-types.js";

const CONFIG_KEYS = ["schema_version", "time_zone", "lease_ms", "deadline_ms", "recovery_window_ms",
  "recovery_lookback_days", "refresh_freshness_ms", "budgets"].sort().join(",");

async function readConfig(path: string): Promise<{ daily: Omit<DailyLoopConfig, "owner_id">; closeoutKey?: TrustedCloseoutKey }> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let text: string;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 8192) throw new Error("CONFIG_INVALID");
      const buffer = Buffer.alloc(8193);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 8192) throw new Error("CONFIG_TOO_LARGE");
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await file.close(); }
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("CONFIG_INVALID");
    const row = value as Record<string, unknown>;
    const { trusted_closeout_key: key, ...base } = row;
    if (Object.keys(base).sort().join(",") !== CONFIG_KEYS) throw new Error("CONFIG_INVALID");
    const closeoutKey = key === undefined ? undefined : parseTrustedCloseoutKey(key);
    const { schema_version: version, ...config } = base;
    if (version !== 1) throw new Error("CONFIG_INVALID");
    return { daily: config as Omit<DailyLoopConfig, "owner_id">, closeoutKey }; // Factory validates before preparing runs.
  } catch { throw new JarvisError("DAILY_LOOP_CONFIG_INVALID"); }
}

export async function executeDailyCommand(context: CliCommandContext): Promise<Record<string, unknown> | undefined> {
  if (context.command !== "daily") return undefined;
  if (context.subcommand === "evening") return executeEveningCommand(context);
  if (context.subcommand !== "morning" || context.positionals.length !== 2
    || context.values.once !== true || !context.values.db || !context.values.input) throw new JarvisError("DAILY_LOOP_CONFIG_INVALID");
  const config = await readConfig(context.values.input);
  try {
    const clock = () => commandNow(context);
    const loop = createStoredMorningDailyLoop(context.db, { ...config.daily, owner_id: `daily-morning:${process.pid}:${randomUUID()}`,
      clock, event_source: { drain: () => [] }, refresh_reader: { read: () => null } }, config.closeoutKey);
    const result = await loop.startup();
    const at = clock();
    if (kstLocalDate(at) !== result.recovery_through_date) throw new JarvisError("DAILY_LOOP_STALE_LEASE");
    return { ok: true, command: "daily.morning", local_date: kstLocalDate(at), observed_at: at.toISOString(), scope: "stored-local-sources",
      provider_refresh: "unavailable", automatic_operation: "hold", ...morningResult(context.db, at, config.closeoutKey), ...result };
  } catch (error) {
    if (error instanceof DailyLoopError) throw new JarvisError(error.code);
    throw error;
  }
}

function morningResult(db: AuthorityDb, at: Date, closeoutKey?: TrustedCloseoutKey) {
  return db.db.transaction(() => {
    const date = kstLocalDate(at); const timestamp = at.toISOString();
    const row = db.db.prepare(`SELECT run_id,state,failure_code,expires_at,lease_expires_at,updated_at FROM daily_loop_runs
      WHERE loop_date=? AND phase='morning'`).get(date) as
      { run_id: string; state: string; failure_code: string | null; expires_at: string;
        lease_expires_at: string | null; updated_at: string } | undefined;
    if (row === undefined) return { run: null, brief: null, usage: dailyLoopUsage(db, date, closeoutKey) };
    const projections = new MemoryProjectionAuthority(db);
    if (projections.isProjectionIdSuppressed(row.run_id)) throw new JarvisError("DAILY_LOOP_RESULT_UNAVAILABLE");
    if (row.updated_at > timestamp) throw new JarvisError("DAILY_LOOP_STALE_LEASE");
    if (row.state === "uncertain") throw new JarvisError("DAILY_LOOP_OUTCOME_UNCERTAIN");
    if (row.state === "failed") throw new JarvisError(`DAILY_LOOP_${row.failure_code}`);
    if (row.state !== "completed") {
      if (timestamp >= row.expires_at) throw new JarvisError("DAILY_LOOP_DEADLINE_EXHAUSTED");
      throw new JarvisError(row.lease_expires_at !== null && timestamp < row.lease_expires_at
        ? "DAILY_LOOP_LEASE_ACTIVE" : "DAILY_LOOP_STALE_LEASE");
    }
    const steps = db.db.prepare("SELECT step_id,step_key,state,detail_json FROM daily_loop_steps WHERE run_id=? ORDER BY sequence")
      .all(row.run_id) as { step_id: string; step_key: string; state: string; detail_json: string }[];
    if (steps.length !== 2 || steps[0]?.step_key !== "refresh_context" || steps[1]?.step_key !== "morning_reconcile"
      || steps.some(step => step.state !== "completed" || projections.isProjectionIdSuppressed(step.step_id))) {
      throw new JarvisError("DAILY_LOOP_RESULT_UNAVAILABLE");
    }
    assertDailyLoopIntegrity(db, row.run_id);
    const brief = verifyMorningBriefResult(JSON.parse(steps[1].detail_json));
    if (projections.isProjectionIdSuppressed(brief.brief_id)) throw new JarvisError("DAILY_LOOP_RESULT_UNAVAILABLE");
    const items = [...brief.needs_you_first, ...brief.waiting, ...brief.fyi];
    if (kstLocalDate(new Date(brief.generated_at)) !== date || brief.generated_at > timestamp
      || items.some(item => item.valid_from > timestamp || item.observed_at > timestamp
        || timestamp >= item.fresh_until || timestamp >= item.valid_until)) throw new JarvisError("DAILY_LOOP_RESULT_STALE");
    return { run: { run_id: row.run_id, state: row.state, failure_code: row.failure_code },
      brief: { brief_id: brief.brief_id, state: brief.context_readiness, item_count: items.length },
      usage: dailyLoopUsage(db, date, closeoutKey) };
  }).deferred();
}
