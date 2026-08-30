import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateLongitudinalDataset, type LongitudinalDataset } from "../../src/personal-os-evaluation.js";

function fixture(): LongitudinalDataset {
  return JSON.parse(readFileSync(join(process.cwd(), "test/fixtures/personal-os/full-loop.json"), "utf8")) as LongitudinalDataset;
}

describe("longitudinal personal OS evaluation", () => {
  it("emits stable passing metrics for the private-safe full-loop fixture", () => {
    const first = evaluateLongitudinalDataset(fixture());
    const second = evaluateLongitudinalDataset(fixture());
    expect(first).toEqual(second);
    expect(first.case_count).toBe(10);
    expect(first.memory.precision).toBeGreaterThanOrEqual(0.85);
    expect(first.memory.recall).toBeGreaterThanOrEqual(0.8);
    expect(first.temporal.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(first.safety.stale_or_no_data_rate).toBe(1);
    expect(first.safety.violations).toBe(0);
    expect(first.passed).toBe(true);
  });

  it("fails deletion leakage and stale-only non-abstention", () => {
    const data = fixture();
    const cases = data.cases.map(item => item.id === "delete-1"
      ? { ...item, observed: { ...item.observed, exposed_deleted_ids: ["mem:forgotten"] } }
      : item.id === "stale-1"
        ? { ...item, observed: { ...item.observed, abstained: false } }
        : item);
    const result = evaluateLongitudinalDataset({ ...data, cases });
    expect(result.safety.deletion_leaks).toBe(1);
    expect(result.safety.stale_or_no_data_rate).toBeLessThan(1);
    expect(result.passed).toBe(false);
  });
});
