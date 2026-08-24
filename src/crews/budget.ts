import { JarvisError } from "../db.js";
import type { CrewBudget, CrewUsage } from "./types.js";

export class CrewBudgetTracker {
  readonly usage: CrewUsage = { tokens: 0, timeMs: 0, toolCalls: 0, spawnDepth: 0, concurrentChildren: 0, cost: 0 };
  constructor(private readonly budget: CrewBudget) {}

  charge(partial: Partial<CrewUsage>): void {
    const next: CrewUsage = { ...this.usage };
    for (const key of Object.keys(this.usage) as (keyof CrewUsage)[]) {
      next[key] += partial[key] ?? 0;
      if (next[key] > this.budget[key]) throw new JarvisError(`CREW_BUDGET_${key.toUpperCase()}`);
    }
    Object.assign(this.usage, next);
  }
}
