import { randomUUID } from "node:crypto";
import { readEveningCliInputs } from "./cli-evening-inputs.js";
import { createStoredMorningDailyLoop } from "./daily-loop-morning-execution.js";
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
  private constructor(private readonly loops: Readonly<Record<Phase, DailyControlLoop>>) {}

  static async fromFiles(db: AuthorityDb, configPath: string, keyPath: string, clock: () => Date): Promise<DailyServiceCycles> {
    const config = await readEveningCliInputs(configPath, keyPath, `daily-service:${process.pid}:${randomUUID()}`, clock);
    return new DailyServiceCycles({
      morning: createStoredMorningDailyLoop(db, config.options, config.trusted),
      evening: createStoredNativeEveningDailyLoop(db, config.options, config.source, config.trusted, config.signer),
    });
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
