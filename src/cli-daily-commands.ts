import { resolve } from "node:path";
import { parseBoundedStrictJson } from "./strict-json.js";
import { randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { commandNow, type CliCommandContext } from "./cli-command-context.js";
import { DailyLoopError, type DailyLoopConfig } from "./daily-loop-types.js";
import { createStoredMorningDailyLoop, type DailyProductionPolicy } from "./daily-loop-morning-execution.js";
import { dailyLoopUsage, parseRefreshContextDetail } from "./daily-loop-usage.js";
import { kstLocalDate } from "./daily-loop-time.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { assertDailyLoopIntegrity } from "./daily-loop-integrity.js";
import { verifyMorningBriefResult } from "./morning-brief-artifact.js";
import { executeEveningCommand } from "./cli-evening-command.js";
import { SecondBrainRefreshReceiptReader } from "./second-brain-refresh-receipt.js";
import { parseTrustedCloseoutKey } from "./evening-closeout-crypto.js";
import type { TrustedCloseoutKey } from "./evening-closeout-types.js";
import { parsePersonalOsPolicy } from "./personal-os-policy.js";
import { createProductionMemoryReference } from "./memory-reference-production.js";

const CONFIG_KEYS = ["schema_version", "time_zone", "lease_ms", "deadline_ms", "recovery_window_ms",
  "recovery_lookback_days", "refresh_freshness_ms", "budgets"];
// Version 2 adds exactly one field. Version 1 keeps its own closed record, so a configuration that
// never mentioned a provider receipt cannot acquire one by accident.
const CONFIG_SHAPES: Readonly<Record<number, string>> = {
  1: [...CONFIG_KEYS].sort().join(","),
  2: [...CONFIG_KEYS, "refresh_receipt_path"].sort().join(","),
};

async function readConfig(path: string): Promise<{ daily: Omit<DailyLoopConfig, "owner_id">;
  closeoutKey?: TrustedCloseoutKey; refreshReceiptPath?: string }> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let text: string;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 8192) throw new Error("CONFIG_INVALID");
      const buffer = Buffer.alloc(8193);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 8192) throw new Error("CONFIG_TOO_LARGE");
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } finally { await file.close(); }
    const value = parseBoundedStrictJson(text, { depth: 32, nodes: 8192, workItems: 32768, characters: 8192 });
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("CONFIG_INVALID");
    const row = value as Record<string, unknown>;
    const { trusted_closeout_key: key, ...base } = row;
    const version = base["schema_version"];
    if (version !== 1 && version !== 2) throw new Error("CONFIG_INVALID");
    if (Object.keys(base).sort().join(",") !== CONFIG_SHAPES[version]) throw new Error("CONFIG_INVALID");
    const closeoutKey = key === undefined ? undefined : parseTrustedCloseoutKey(key);
    const receiptPath = base["refresh_receipt_path"];
    if (version === 2 && (typeof receiptPath !== "string" || !receiptPath.startsWith("/")
      || receiptPath.length > 512 || receiptPath.includes("\0"))) throw new Error("CONFIG_INVALID");
    const config = Object.fromEntries(Object.entries(base)
      .filter(([name]) => name !== "schema_version" && name !== "refresh_receipt_path"));
    // Factory validates before preparing runs.
    return { daily: config as Omit<DailyLoopConfig, "owner_id">, closeoutKey,
      ...(version === 2 ? { refreshReceiptPath: String(receiptPath) } : {}) };
  } catch { throw new JarvisError("DAILY_LOOP_CONFIG_INVALID"); }
}

/**
 * What the morning run may rest on when it produces, read from the policy document this deployment
 * ships. A deployment without one produces nothing rather than inventing a policy, and the run still
 * publishes whatever is already on record.
 */
async function dailyProductionPolicy(db: AuthorityDb, clock: () => Date): Promise<DailyProductionPolicy | undefined> {
  let policy: unknown;
  let decisionRef: string;
  try {
    policy = JSON.parse(readFileSync(resolve(process.cwd(), "config/personal-os-policy.json"), "utf8"));
    decisionRef = `policy:linux:${parsePersonalOsPolicy(policy).policy_id}:daily-morning`;
  } catch { return undefined; }
  // A deployment that names no memory provider is not a broken one: it produces nothing that rests
  // on a memory and still publishes what is already on record. Reaching for a default launcher path
  // here would start the operational provider on a host that never asked for it.
  if (process.env["JARVIS_SECOND_BRAIN_LAUNCHER"] === undefined) {
    return { policy, policy_decision_ref: decisionRef };
  }
  const runtime = createProductionMemoryReference(db, { clock });
  try {
    // A successful read has already awaited the transport shutdown before its final check.
    const reference = await runtime.reader.read("What should happen next?",
      { max_records: 8, max_record_bytes: 4_096, max_bytes: 32_768 }, runtime.close);
    return { policy, policy_decision_ref: decisionRef, memory_reference: reference };
  } catch {
    // An unavailable or refused provider withholds the memory, and the run reports that as an
    // abstention. Failing the whole morning because a read did not come back would be worse.
    await runtime.close().catch(() => undefined);
    return { policy, policy_decision_ref: decisionRef };
  }
}

export async function executeDailyCommand(context: CliCommandContext): Promise<Record<string, unknown> | undefined> {
  if (context.command !== "daily") return undefined;
  if (context.subcommand === "evening") return executeEveningCommand(context);
  if (context.subcommand !== "morning" || context.positionals.length !== 2
    || context.values.once !== true || !context.values.db || !context.values.input) throw new JarvisError("DAILY_LOOP_CONFIG_INVALID");
  const config = await readConfig(context.values.input);
  try {
    const clock = () => commandNow(context);
    // The loop takes a plain closed record, so the adapter is delegated to rather than handed over.
    const receipts = new SecondBrainRefreshReceiptReader(config.refreshReceiptPath);
    const loop = createStoredMorningDailyLoop(context.db, { ...config.daily, owner_id: `daily-morning:${process.pid}:${randomUUID()}`,
      clock, event_source: { drain: () => [] },
      refresh_reader: { read: (at: Date) => receipts.read(at) } },
    config.closeoutKey, await dailyProductionPolicy(context.db, clock));
    const result = await loop.startup();
    const at = clock();
    if (kstLocalDate(at) !== result.recovery_through_date) throw new JarvisError("DAILY_LOOP_STALE_LEASE");
    return { ok: true, command: "daily.morning", local_date: kstLocalDate(at), observed_at: at.toISOString(), scope: "stored-local-sources",
      automatic_operation: "hold", ...morningResult(context.db, at, config.closeoutKey), ...result };
  } catch (error) {
    if (error instanceof DailyLoopError) throw new JarvisError(error.code);
    throw error;
  }
}

/** How the stored reason reads on the command surface. `refresh_missing` keeps its old word. */
const PROVIDER_REFRESH: Readonly<Record<string, string>> = {
  refresh_missing: "unavailable", refresh_fresh: "fresh", refresh_failed: "failed",
  refresh_stale: "stale", refresh_incompatible: "incompatible", refresh_capped: "capped",
  refresh_invalid: "invalid",
};

function morningResult(db: AuthorityDb, at: Date, closeoutKey?: TrustedCloseoutKey) {
  return db.db.transaction(() => {
    const date = kstLocalDate(at); const timestamp = at.toISOString();
    const row = db.db.prepare(`SELECT run_id,state,failure_code,expires_at,lease_expires_at,updated_at FROM daily_loop_runs
      WHERE loop_date=? AND phase='morning'`).get(date) as
      { run_id: string; state: string; failure_code: string | null; expires_at: string;
        lease_expires_at: string | null; updated_at: string } | undefined;
    if (row === undefined) {
      return { provider_refresh: "unavailable", run: null, brief: null,
        usage: dailyLoopUsage(db, date, closeoutKey) };
    }
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
    // Reported from the step the run actually stored, not from a constant: a provider refresh that
    // arrived capped, stale or in an unsupported shape must be visible as that, not as "unavailable".
    const refresh = parseRefreshContextDetail(JSON.parse(steps[0].detail_json));
    const brief = verifyMorningBriefResult(JSON.parse(steps[1].detail_json));
    if (projections.isProjectionIdSuppressed(brief.brief_id)) throw new JarvisError("DAILY_LOOP_RESULT_UNAVAILABLE");
    const items = [...brief.needs_you_first, ...brief.waiting, ...brief.fyi];
    if (kstLocalDate(new Date(brief.generated_at)) !== date || brief.generated_at > timestamp
      || items.some(item => item.valid_from > timestamp || item.observed_at > timestamp
        || timestamp >= item.fresh_until || timestamp >= item.valid_until)) throw new JarvisError("DAILY_LOOP_RESULT_STALE");
    return { provider_refresh: PROVIDER_REFRESH[refresh.reason],
      run: { run_id: row.run_id, state: row.state, failure_code: row.failure_code },
      brief: { brief_id: brief.brief_id, state: brief.context_readiness, item_count: items.length },
      usage: dailyLoopUsage(db, date, closeoutKey) };
  }).deferred();
}
