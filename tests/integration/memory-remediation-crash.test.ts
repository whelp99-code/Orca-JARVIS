import { describe, expect, it } from "vitest";
import { runRecoveryCrash } from "../fixtures/memory-remediation-crash.js";

const scenarios = (["correction", "deletion"] as const).flatMap(lane =>
  (["jarvis_suppression_tombstone_commit", "before_settlement_commit"] as const)
    .map(barrier => ({ lane, barrier })));

describe("built production lifecycle crash recovery", () => {
  it.each(scenarios)("settles $lane once after SIGKILL at $barrier", async scenario => {
    // Given: synthetic provider state, signed authority and an exact durable barrier event.
    // When: the supervisor kills the process and starts the built lifecycle CLI handler in a new process.
    const recovered = await runRecoveryCrash(scenario);
    // Then: the original single effect settles; completed compaction goes through recover, not compact.
    expect(recovered.recovered).toHaveLength(scenario.barrier === "before_settlement_commit" ? 1 : 0);
    expect(recovered).toMatchObject({ frames: 1, effects: 1, tombstones: 1, purges: 1,
      effect_rows: { count: 1 }, redemption_rows: { count: 1 } });
  }, 30_000);
});
