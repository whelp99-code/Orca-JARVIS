import type { AuthorityDb } from "./db.js";
import { DailyControlLoop } from "./daily-loop-service.js";
import { DailyLoopStore } from "./daily-loop-store.js";
import { parseDailyLoopClaim, parseDailyLoopOptions } from "./daily-loop-input.js";
import { assertDailyLoopIntegrity } from "./daily-loop-integrity.js";
import { kstLocalDate } from "./daily-loop-time.js";
import { DailyLoopError, type DailyLoopClaim, type DailyLoopOptions, type DailyLoopStepExecutor } from "./daily-loop-types.js";
import { parseNativeEveningSourceConfig, type NativeEveningSourceConfig } from "./evening-native-source.js";
import { parseTrustedCloseoutKey } from "./evening-closeout-crypto.js";
import type { CloseoutSigningHandle, TrustedCloseoutKey } from "./evening-closeout-types.js";
import { generateNativeEveningEnvelope } from "./evening-native-envelope.js";
import { NativeEveningStore } from "./evening-native-store.js";
import { DailyBudgetExceeded, dailyLoopUsage, dailyUsageExhausted } from "./daily-loop-usage.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";

/** Explicit native publication composition; caller owns source authorization and signing capability. */
export function createStoredNativeEveningDailyLoop(db: AuthorityDb, optionsValue: DailyLoopOptions,
  configValue: NativeEveningSourceConfig, trustedValue: TrustedCloseoutKey, signer: CloseoutSigningHandle): DailyControlLoop {
  const parsed = parseDailyLoopOptions(optionsValue);
  const config = parseNativeEveningSourceConfig(configValue); const trusted = parseTrustedCloseoutKey(trustedValue);
  let lastAt: Date | undefined;
  const options: DailyLoopOptions = { ...parsed, clock: () => {
    const at = parsed.clock();
    if (lastAt !== undefined && at < lastAt) throw new DailyLoopError("DAILY_LOOP_STALE_LEASE");
    lastAt = at; return at;
  } };
  const store = new DailyLoopStore(db);
  const native = new NativeEveningStore(db, trusted, config, options.clock);
  const executor: DailyLoopStepExecutor = {
    advance(value) {
      const claim = parseDailyLoopClaim(value);
      return db.db.transaction(() => {
        const at = options.clock(); assertDailyLoopIntegrity(db, claim.run_id);
        const row = db.db.prepare("SELECT * FROM daily_loop_runs WHERE run_id=?").get(claim.run_id) as
          Record<string, unknown> | undefined;
        if (row === undefined || row.phase !== "evening") throw new DailyLoopError("DAILY_LOOP_HANDLER_UNAVAILABLE");
        if (row.record_version !== 1 || row.loop_date !== kstLocalDate(at)
          || !["claimed", "running"].includes(String(row.state)) || row.lease_owner !== claim.owner_id
          || row.lease_fence !== claim.fence || row.lease_expires_at !== claim.lease_expires_at
          || row.expires_at !== claim.deadline_at || at.toISOString() < String(row.updated_at)
          || at.toISOString() < String(row.not_before)) throw new DailyLoopError("DAILY_LOOP_STALE_LEASE");
        if (options.deadline_ms === 0) {
          store.fail(claim, "DEADLINE_EXHAUSTED", at); return "failed" as const;
        }
        store.start(claim, at); // Validate current lease before any source read or signing.
        const steps = store.steps(claim.run_id); const step = steps[0];
        const projections = new MemoryProjectionAuthority(db);
        if (steps.length !== 1 || step?.step_key !== "evening_summary" || step.sequence !== 1 || step.state !== "pending"
          || projections.isProjectionIdSuppressed(claim.run_id) || projections.isProjectionIdSuppressed(step.step_id)) {
          throw new DailyLoopError("DAILY_LOOP_INTEGRITY_FAILURE");
        }
        const exhausted = dailyUsageExhausted(dailyLoopUsage(db, row.loop_date, trusted), options.budgets);
        if (exhausted !== null) { store.fail(claim, exhausted, at); return "failed" as const; }
        const artifact = generateNativeEveningEnvelope(db, { ...config, run_id: claim.run_id,
          correlation_id: String(row.correlation_id), local_date: String(row.loop_date), observed_at: at },
        { identity: signer.identity, clock: () => at, sign: bytes => signer.sign(bytes) });
        try { native.settleWithinBudget({ claim, artifact }, options.budgets); }
        catch (error) {
          if (!(error instanceof DailyBudgetExceeded)) throw error;
          store.fail(claim, error.code, options.clock()); return "failed" as const;
        }
        return "all_completed" as const;
      }).immediate();
    },
    complete(value: DailyLoopClaim) {
      const claim = parseDailyLoopClaim(value);
      native.read(claim.run_id); // Publication already completed the ledger atomically.
    },
  };
  return new DailyControlLoop(store, options, executor, "evening", true);
}
