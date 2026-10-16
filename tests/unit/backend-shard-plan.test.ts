import { describe, expect, it } from "vitest";
import {
  BACKEND_SHARD_COUNT,
  backendShardRuns,
  backendShardsRunInParallel,
} from "../../scripts/lib/backend-shard-plan.mjs";

describe("backend shard plan", () => {
  const base = ["/vitest.mjs", "run"];

  it("keeps a single argv for filtered backend runs", () => {
    expect(backendShardRuns("backend", ["tests/unit/foo.test.ts"], base)).toEqual([base]);
    expect(backendShardsRunInParallel("backend", ["tests/unit/foo.test.ts"])).toBe(false);
  });

  it("plans unit and integration shards for the default backend profile", () => {
    const runs = backendShardRuns("backend", [], base);
    expect(runs).toHaveLength(BACKEND_SHARD_COUNT);
    expect(runs[0]).toEqual([...base, "tests/unit"]);
    expect(runs[1]).toEqual([...base, "tests/integration", "tests/longitudinal"]);
    expect(backendShardsRunInParallel("backend", [])).toBe(true);
  });

  it("does not parallelize non-backend profiles", () => {
    expect(backendShardsRunInParallel("dashboard", [])).toBe(false);
    expect(backendShardRuns("dashboard", [], base)).toEqual([base]);
  });
});
