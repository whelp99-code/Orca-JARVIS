import { randomUUID } from "node:crypto";
import { readEveningCliInputs } from "./cli-evening-inputs.js";
import { createStoredMorningDailyLoop, type DailyProductionPolicy } from "./daily-loop-morning-execution.js";
import { dailyProductionPolicy } from "./daily-production-policy.js";
import { createStoredNativeEveningDailyLoop } from "./daily-loop-evening-execution.js";
import type { DailyControlLoop } from "./daily-loop-service.js";
import { DailyLoopError, type DailyLoopCycleResult } from "./daily-loop-types.js";
import { JarvisError, type AuthorityDb } from "./db.js";

type Phase = "morning" | "evening";
type PhaseCycle = { readonly status: "processed"; readonly result: DailyLoopCycleResult }
  | { readonly status: "error"; readonly code: string };

/** Concrete stored-source executors; no placeholder steps or external provider calls. */
export class DailyServiceCycles {
  private active = false;
  private readonly started = new Set<Phase>();
  private constructor(private readonly loops: Readonly<Record<Phase, DailyControlLoop>>,
    private readonly refreshProduction: () => Promise<void>) {}

  static async fromFiles(db: AuthorityDb, configPath: string, keyPath: string, clock: () => Date): Promise<DailyServiceCycles> {
    const config = await readEveningCliInputs(configPath, keyPath, `daily-service:${process.pid}:${randomUUID()}`, clock);
    // The configured service produces under the same policy the `daily morning` command produces
    // under, derived from the same configured sources: the shipped policy document, the decision
    // reference built from it, and the provider read this deployment names. A deployment that names
    // no provider withholds the memory and the morning still publishes what is on record.
    //
    // It is re-derived before each morning phase rather than once at startup, because a service
    // that ran for a week would otherwise be producing against the provider read it made on the day
    // it was started. The read is IO and stays out here, in the async cycle, never inside the step.
    let production: DailyProductionPolicy | undefined;
    return new DailyServiceCycles({
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
      // "processed" describes the cycle, not successful artifact publication.
      return { status: "processed", result };
    } catch (error) {
      return { status: "error", code: error instanceof DailyLoopError || error instanceof JarvisError
        ? error.code : "DAILY_LOOP_SERVICE_ERROR" };
    }
  }
}
