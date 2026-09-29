import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";
import { execute } from "../../src/cli.js";
import { passiveCapabilityProbe } from "../../src/doctor-capability-probe.js";
import { AuthorityDb } from "../../src/db.js";
import { tempDb } from "../helpers.js";

describe("Second Brain readiness public seam", () => {
  it("exports the canonical evaluator and adds its report to capabilities JSON", async () => {
    // Given: a migrated authority with no ambient provider assumptions.
    const db = new AuthorityDb(tempDb());
    await db.migrate();

    try {
      // When: the public API and capabilities JSON are inspected.
      const capabilities = await execute(["--db", db.filename, "capabilities", "--json"], {
        clock: () => new Date("2026-08-28T12:00:00.000Z"),
        capabilityProbe: passiveCapabilityProbe(),
        secondBrainProbe: publicApi.passiveSecondBrainReadinessProbe(),
      });

      // Then: the additive canonical Second Brain seam is present.
      expect("evaluateSecondBrainReadiness" in publicApi).toBe(true);
      expect(capabilities).toHaveProperty("second_brain");
    } finally {
      db.close();
    }
  });
});
