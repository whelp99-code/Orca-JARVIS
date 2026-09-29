import { randomUUID } from "node:crypto";
import { readEveningCliInputs } from "./cli-evening-inputs.js";
import { createStoredMorningDailyLoop, type DailyProductionPolicy } from "./daily-loop-morning-execution.js";
import { dailyProductionPolicy } from "./daily-production-policy.js";
import { createStoredNativeEveningDailyLoop } from "./daily-loop-evening-execution.js";
import { errorCode, type DailyControlLoop } from "./daily-loop-service.js";
import { failureDetail } from "./daily-loop-store-input.js";
import type { DailyLoopCycleResult } from "./daily-loop-types.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { bindMorningHold, installMorningRefreshSubscription, loadMorningOperatingBrief } from "./morning-operating-brief.js";
import { kstLocalDate } from "./daily-loop-time.js";

type Phase = "morning" | "evening";
type PhaseCycle = {
  readonly status: "processed";
  readonly result: DailyLoopCycleResult;
  readonly operating_brief?: ReturnType<typeof loadMorningOperatingBrief>;
}
  | { readonly status: "error"; readonly code: string };

/** Concrete stored-source executors; no placeholder steps or external provider calls. */
export class DailyServiceCycles {
  private active = false;
  private readonly started = new Set<Phase>();
  private constructor(private readonly db: AuthorityDb, private readonly clock: () => Date,
    private readonly loops: Readonly<Record<Phase, DailyControlLoop>>,
    private readonly refreshProduction: () => Promise<void>) {}

  static async fromFiles(db: AuthorityDb, configPath: string, keyPath: string, clock: () => Date): Promise<DailyServiceCycles> {
    const bound = bindMorningHold(clock, false);
    const config = await readEveningCliInputs(configPath, keyPath, `daily-service:${process.pid}:${randomUUID()}`, bound);
    // The configured service produces under the same policy the `daily morning` command produces
    // under, derived from the same configured sources: the shipped policy document, the decision
    // reference built from it, and the provider read this deployment names. A deployment that names
    // no provider withholds the memory and the morning still publishes what is on record.
    //
    // It is re-derived before each morning phase rather than once at startup, because a service
    // that ran for a week would otherwise be producing against the provider read it made on the day
    // it was started. The read is IO and stays out here, in the async cycle, never inside the step.
    let production: DailyProductionPolicy | undefined;
    installMorningRefreshSubscription(db, bound());
    return new DailyServiceCycles(db, bound, {
      morning: createStoredMorningDailyLoop(db, config.options, config.trusted, () => production),
      evening: createStoredNativeEveningDailyLoop(db, config.options, config.source, config.trusted, config.signer),
    }, async () => { production = await dailyProductionPolicy(db, clock); });
  }

  async cycle(): Promise<Readonly<Record<Phase, PhaseCycle>>> {
    if (this.active) throw new JarvisError("DAILY_LOOP_SERVICE_BUSY");
    this.active = true;
    try {
      return { morning: await this.phase("morning"), evening: await this.phase("evening") };
    } finally { this.active = false; }
  }

  private async phase(phase: Phase): Promise<PhaseCycle> {
    try {
      // Failure isolation covers this too: a provider that cannot be read leaves the morning with
      // no memory reference, which is an abstention, and a policy document that cannot be read
      // leaves it with nothing to produce under - neither stops the evening phase.
      if (phase === "morning") await this.refreshProduction();
      const result = await (this.started.has(phase) ? this.loops[phase].cycle() : this.loops[phase].startup());
      this.started.add(phase);
      const operating = phase === "morning"
        ? this.db.db.prepare(`SELECT s.detail_json FROM daily_loop_steps s
            JOIN daily_loop_runs r ON r.run_id=s.run_id
            WHERE r.loop_date=? AND r.phase='morning' AND s.step_key='morning_reconcile' AND s.state='completed'
            ORDER BY s.updated_at DESC LIMIT 1`).get(kstLocalDate(this.clock())) as { detail_json: string } | undefined
        : undefined;
      const briefId = operating === undefined ? undefined : JSON.parse(operating.detail_json).brief_id as string;
      // "processed" describes the cycle, not successful artifact publication.
      return { status: "processed", result,
        ...(phase === "morning" ? { operating_brief: briefId === undefined ? null : loadMorningOperatingBrief(this.db, briefId) } : {}) };
    } catch (error) {
      // Every phase refuses with a code, and not every one of those codes belongs to a DailyLoopError
      // or a JarvisError: the evening publication refuses with an EveningCloseoutError. Flattening
      // them all to one opaque service error left the operator with no reason to read at all, so any
      // bounded code an error carries is reported as the reason this phase did not run.
      return { status: "error", code: failureDetail(errorCode(error), "DAILY_LOOP_SERVICE_ERROR") };
    }
  }
}
