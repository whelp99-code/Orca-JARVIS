import { randomUUID } from "node:crypto";
import { commandNow, type CliCommandContext } from "./cli-command-context.js";
import { readEveningCliInputs } from "./cli-evening-inputs.js";
import { createStoredNativeEveningDailyLoop } from "./daily-loop-evening-execution.js";
import { NativeEveningStore } from "./evening-native-store.js";
import { dailyLoopUsage } from "./daily-loop-usage.js";
import { kstLocalDate } from "./daily-loop-time.js";
import { DailyLoopError } from "./daily-loop-types.js";
import { JarvisError } from "./db.js";

export async function executeEveningCommand(context: CliCommandContext): Promise<Record<string, unknown>> {
  if (context.positionals.length !== 2 || context.values.once !== true || !context.values.db
    || !context.values.input || !context.values["key-file"]) throw new JarvisError("DAILY_LOOP_CONFIG_INVALID");
  const clock = () => commandNow(context);
  const config = await readEveningCliInputs(context.values.input, context.values["key-file"],
    `daily-evening:${process.pid}:${randomUUID()}`, clock);
  try {
    const loop = createStoredNativeEveningDailyLoop(context.db, config.options, config.source, config.trusted, config.signer);
    const result = await loop.startup(); const at = clock(); const date = kstLocalDate(at);
    if (date !== result.recovery_through_date) throw new JarvisError("DAILY_LOOP_STALE_LEASE");
    const summary = context.db.db.transaction(() => {
      const row = context.db.db.prepare(`SELECT run_id,state,failure_code,expires_at,lease_expires_at,updated_at
        FROM daily_loop_runs WHERE loop_date=? AND phase='evening'`).get(date) as
        { run_id: string; state: string; failure_code: string | null; expires_at: string;
          lease_expires_at: string | null; updated_at: string } | undefined;
      if (row === undefined) return { run: null, report: null, usage: dailyLoopUsage(context.db, date, config.trusted) };
      if (row.updated_at > at.toISOString()) throw new JarvisError("DAILY_LOOP_STALE_LEASE");
      if (row.state === "uncertain") throw new JarvisError("DAILY_LOOP_OUTCOME_UNCERTAIN");
      if (row.state === "failed") throw new JarvisError(`DAILY_LOOP_${row.failure_code}`);
      if (row.state !== "completed") {
        if (at.toISOString() >= row.expires_at) throw new JarvisError("DAILY_LOOP_DEADLINE_EXHAUSTED");
        throw new JarvisError(row.lease_expires_at !== null && at.toISOString() < row.lease_expires_at
          ? "DAILY_LOOP_LEASE_ACTIVE" : "DAILY_LOOP_STALE_LEASE");
      }
      const artifact = new NativeEveningStore(context.db, config.trusted, config.source, () => at).read(row.run_id);
      return { run: { run_id: row.run_id, state: row.state }, report: { artifact_id: artifact.artifact_id,
        canonical_digest: artifact.canonical_digest, native_completion_count: artifact.native_completion_count,
        source_readiness: artifact.source_readiness, source_omissions: artifact.source_omissions },
      usage: dailyLoopUsage(context.db, date, config.trusted) };
    }).deferred();
    return { ok: true, command: "daily.evening", local_date: date, observed_at: at.toISOString(),
      scope: "stored-native-completions", automatic_operation: "hold", ...summary, ...result };
  } catch (error) {
    if (error instanceof JarvisError) throw error;
    if (error instanceof DailyLoopError) throw new JarvisError(error.code);
    throw new JarvisError("DAILY_LOOP_RESULT_UNAVAILABLE");
  }
}
