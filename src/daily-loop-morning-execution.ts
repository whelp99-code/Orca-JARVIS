import type { AuthorityDb } from "./db.js";
import { DailyControlLoop } from "./daily-loop-service.js";
import { DailyLoopStore } from "./daily-loop-store.js";
import { parseDailyLoopClaim, parseDailyLoopOptions } from "./daily-loop-input.js";
import { assertDailyLoopIntegrity } from "./daily-loop-integrity.js";
import { evaluateRefreshContext, kstLocalDate } from "./daily-loop-time.js";
import { DailyLoopError, type DailyLoopAdvance, type DailyLoopClaim,
  type DailyLoopOptions, type DailyLoopStepExecutor } from "./daily-loop-types.js";
import { DailyBudgetExceeded, dailyLoopUsage, dailyUsageExhausted } from "./daily-loop-usage.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { MorningBriefPublisher } from "./morning-brief-publisher.js";
import { parseTrustedCloseoutKey } from "./evening-closeout-crypto.js";
import type { TrustedCloseoutKey } from "./evening-closeout-types.js";

/** Explicit morning composition. Unimplemented phases fail instead of emitting placeholder success. */
export function createStoredMorningDailyLoop(authority: AuthorityDb, optionsValue: DailyLoopOptions,
  closeoutKeyValue?: TrustedCloseoutKey): DailyControlLoop {
  const closeoutKey = closeoutKeyValue === undefined ? undefined : parseTrustedCloseoutKey(closeoutKeyValue);
  const parsed = parseDailyLoopOptions(optionsValue); let lastAt: Date | null = null;
  const options: DailyLoopOptions = { ...parsed, clock: () => {
    const at = parsed.clock();
    if (lastAt !== null && at < lastAt) throw new DailyLoopError("DAILY_LOOP_STALE_LEASE");
    lastAt = at; return at;
  } };
  const store = new DailyLoopStore(authority);
  return new DailyControlLoop(store, options, new StoredMorningSteps(authority, store, options, closeoutKey), "morning", true);
}

class StoredMorningSteps implements DailyLoopStepExecutor {
  constructor(private readonly authority: AuthorityDb, private readonly store: DailyLoopStore,
    private readonly options: DailyLoopOptions, private readonly closeoutKey?: TrustedCloseoutKey) {}

  complete(claimValue: DailyLoopClaim): void {
    const claim = parseDailyLoopClaim(claimValue);
    this.authority.db.transaction(() => {
      if (this.advance(claim) !== "all_completed") throw new DailyLoopError("DAILY_LOOP_INTEGRITY_FAILURE");
      const at = this.options.clock();
      const row = this.authority.db.prepare(`SELECT loop_date,updated_at,
        (SELECT MAX(updated_at) FROM daily_loop_steps WHERE run_id=r.run_id) AS latest_step_at
        FROM daily_loop_runs r WHERE run_id=?`).get(claim.run_id) as Record<string, string>;
      if (kstLocalDate(at) !== row["loop_date"] || at.toISOString() < String(row["updated_at"])
        || at.toISOString() < String(row["latest_step_at"])) throw new DailyLoopError("DAILY_LOOP_STALE_LEASE");
      this.store.complete(claim, at);
    }).immediate();
  }

  advance(claimValue: DailyLoopClaim): DailyLoopAdvance {
    const claim = parseDailyLoopClaim(claimValue);
    return this.authority.db.transaction((): DailyLoopAdvance => {
      const at = this.options.clock(); const timestamp = at.toISOString();
      const projections = new MemoryProjectionAuthority(this.authority); projections.assertReady();
      assertDailyLoopIntegrity(this.authority, claim.run_id);
      const run = this.authority.db.prepare(`SELECT *,
        (SELECT MAX(updated_at) FROM daily_loop_steps WHERE run_id=r.run_id) AS latest_step_at
        FROM daily_loop_runs r WHERE run_id=?`).get(claim.run_id) as
        Record<string, unknown> | undefined;
      if (run === undefined || run["record_version"] !== 1 || run["loop_date"] !== kstLocalDate(at)
        || !["claimed", "running"].includes(String(run["state"])) || run["lease_owner"] !== claim.owner_id
        || run["lease_fence"] !== claim.fence || run["lease_expires_at"] !== claim.lease_expires_at
        || run["expires_at"] !== claim.deadline_at || timestamp < String(run["created_at"])
        || timestamp < String(run["updated_at"]) || timestamp < String(run["not_before"])
        || timestamp < String(run["latest_step_at"])
        || projections.isProjectionIdSuppressed(claim.run_id)) throw new DailyLoopError("DAILY_LOOP_STALE_LEASE");
      if (run["phase"] !== "morning") throw new DailyLoopError("DAILY_LOOP_HANDLER_UNAVAILABLE");
      const input = JSON.parse(String(run["input_json"])); const steps = this.store.steps(claim.run_id);
      if (input.phase !== "morning" || input.local_date !== run["loop_date"] || !Array.isArray(input.steps)
        || steps.length !== input.steps.length || steps.length !== 2
        || steps[0]?.step_key !== "refresh_context" || steps[1]?.step_key !== "morning_reconcile"
        || steps.some((step, index) => step.sequence !== index + 1 || input.steps[index]?.key !== step.step_key
          || input.steps[index]?.sequence !== step.sequence)) throw new DailyLoopError("DAILY_LOOP_INTEGRITY_FAILURE");
      if (this.options.deadline_ms === 0 || timestamp >= claim.deadline_at) {
        this.store.fail(claim, "DEADLINE_EXHAUSTED", at); return "failed";
      }
      const used = dailyLoopUsage(this.authority, run["loop_date"], this.closeoutKey);
      this.store.start(claim, at);
      const exhausted = dailyUsageExhausted(used, this.options.budgets);
      if (exhausted !== null) { this.store.fail(claim, exhausted, at); return "failed"; }
      const step = steps.find(item => item.state !== "completed");
      if (step === undefined) return "all_completed";
      if (step.state !== "pending") throw new DailyLoopError("DAILY_LOOP_INTEGRITY_FAILURE");
      if (used.work >= this.options.budgets.max_work) {
        this.store.fail(claim, "BUDGET_WORK_EXHAUSTED", at); return "failed";
      }
      let lastAt = at;
      const now = () => {
        const next = this.options.clock();
        if (next < lastAt || kstLocalDate(next) !== run["loop_date"]) throw new DailyLoopError("DAILY_LOOP_STALE_LEASE");
        lastAt = next; return next;
      };
      try {
        this.authority.db.transaction(() => {
          if (step.step_key === "morning_reconcile") {
            new MorningBriefPublisher(this.authority, now).publish(claim, 1_048_576);
          } else {
            const refresh = this.options.refresh_reader.read(at); const completedAt = now();
            const detail = evaluateRefreshContext(refresh, completedAt, this.options.refresh_freshness_ms);
            this.store.completeStep({ claim, step, detail, at: completedAt });
          }
          const code = dailyUsageExhausted(dailyLoopUsage(this.authority, run["loop_date"], this.closeoutKey), this.options.budgets);
          if (code !== null) throw new DailyBudgetExceeded(code);
          const finishedAt = now();
          this.store.start(claim, finishedAt);
        })();
      } catch (error) {
        if (!(error instanceof DailyBudgetExceeded)) throw error;
        this.store.fail(claim, error.code, now()); return "failed";
      }
      return "step_completed";
    }).immediate();
  }
}
