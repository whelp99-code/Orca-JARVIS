import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createTestEnvironment } from "../../scripts/lib/test-environment.mjs";
import { describe, expect, it } from "vitest";
import {
  BACKEND_SHARD_COUNT,
  backendShardRuns,
  backendShardsRunInParallel,
  classifyTestResult,
  combineShardExit,
  headlessGuiPlan,
  settleParallelShards,
  vitestCacheDir,
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

  it("keeps a signal death nonzero and does not treat a null exit as success", () => {
    expect(classifyTestResult({ code: null, signal: "SIGKILL", interrupted: false })).toEqual({
      interrupted: false, code: 137, signal: "SIGKILL",
    });
    expect(classifyTestResult({ code: null, signal: null, interrupted: false }).code).toBe(1);
    expect(classifyTestResult({ code: null, signal: "SIGTERM", interrupted: true })).toEqual({
      interrupted: true, code: 130, signal: "SIGTERM",
    });
    expect(classifyTestResult({ code: 0, signal: null }).code).toBe(0);
  });

  it("plans headless Linux GUI argv as bwrap before the node entry", () => {
    const entry = ["/repo/scripts/gui-test-entry.mjs"];
    const planned = headlessGuiPlan({
      profile: "gui", platform: "linux", display: "", argv: entry, execPath: "/usr/bin/node", privateTmp: "/private",
    });
    expect(planned.command).toBe("bwrap");
    expect(planned.argv.at(-2)).toBe("/usr/bin/node");
    expect(planned.argv.at(-1)).toBe(entry[0]);
    expect(planned.argv[0]).toBe("--die-with-parent");
    expect(headlessGuiPlan({
      profile: "gui", platform: "linux", display: ":1", argv: entry, execPath: "/usr/bin/node", privateTmp: "/private",
    })).toEqual({ command: "/usr/bin/node", argv: entry });
  });

  it("uses a trimmed Vite cache directory only when the shard env is set", () => {
    expect(vitestCacheDir({ VITEST_CACHE_DIR: "/tmp/shard-a" })).toBe("/tmp/shard-a");
    expect(vitestCacheDir({ VITEST_CACHE_DIR: "  " })).toBeUndefined();
    expect(vitestCacheDir({})).toBeUndefined();
  });

  it("cleans every shard scratch and aborts the sibling when one shard throws", async () => {
    const cleaned: number[] = [];
    let nextId = 0;
    const parent = new AbortController();
    let siblingSignal: AbortSignal | undefined;
    const settled = await settleParallelShards({
      runs: [["shard-a"], ["shard-b"]],
      parentSignal: parent.signal,
      createEnvironment: () => {
        const id = nextId;
        nextId += 1;
        return { env: {}, root: String(id), cleanup: () => { cleaned.push(id); } };
      },
      runShard: async (_argv, _scratch, signal, index) => {
        if (index === 0) throw new Error("TEST_RUN_TIMEOUT");
        siblingSignal = signal;
        await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
        return { interrupted: true, code: 130, signal: "SIGTERM" };
      },
    });
    expect(siblingSignal?.aborted).toBe(true);
    expect(cleaned).toEqual([0, 1]);
    expect(settled.exitCode).toBe(2);
    expect([...settled.outcomes.map((outcome) => outcome.code)].sort((left, right) => left - right)).toEqual([2, 130]);
  });

  it("lets a sibling finish after an ordinary assertion failure", async () => {
    const cleaned: number[] = [];
    let id = 0;
    let siblingFinished = false;
    const settled = await settleParallelShards({
      runs: [["shard-a"], ["shard-b"]],
      parentSignal: new AbortController().signal,
      createEnvironment: () => {
        const current = id++;
        return { env: {}, root: String(current), cleanup: () => { cleaned.push(current); } };
      },
      runShard: async (_argv, _scratch, signal, index) => {
        if (index === 0) return { interrupted: false, code: 1, signal: null };
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(signal.aborted).toBe(false);
        siblingFinished = true;
        return { interrupted: false, code: 0, signal: null };
      },
    });
    expect(siblingFinished).toBe(true);
    expect(settled.outcomes.map(outcome => outcome.code)).toEqual([1, 0]);
    expect(settled.exitCode).toBe(1);
    expect(cleaned).toEqual([0, 1]);
  });

  it.each([
    { interrupted: false, code: 137, signal: "SIGKILL" },
    { interrupted: true, code: 130, signal: null },
  ] as const)("still aborts siblings for a runner interruption or signal: %j", async failure => {
    let siblingAborted = false;
    const settled = await settleParallelShards({
      runs: [["shard-a"], ["shard-b"]],
      parentSignal: new AbortController().signal,
      createEnvironment: () => ({ env: {}, root: "scratch", cleanup() {} }),
      runShard: async (_argv, _scratch, signal, index) => {
        if (index === 0) return failure;
        await new Promise<void>(resolve => setImmediate(resolve));
        siblingAborted = signal.aborted;
        return { interrupted: true, code: 130, signal: "SIGTERM" };
      },
    });
    expect(siblingAborted).toBe(true);
    expect(settled.exitCode).toBe(failure.code);
  });

  it("keeps the real shard failure when a sibling is aborted", () => {
    expect(combineShardExit([{ code: 1 }, { code: 130, interrupted: true }], false)).toBe(1);
    expect(combineShardExit([{ code: 0 }, { code: 130, interrupted: true }], true)).toBe(130);
  });

  it("does not parallelize non-backend profiles", () => {
    expect(backendShardsRunInParallel("dashboard", [])).toBe(false);
    expect(backendShardRuns("dashboard", [], base)).toEqual([base]);
  });

  it("gives each parallel shard its own createTestEnvironment run directory", async () => {
    const seen: string[] = [];
    const settled = await settleParallelShards({
      runs: [["shard-a"], ["shard-b"]],
      parentSignal: new AbortController().signal,
      createEnvironment: createTestEnvironment,
      runShard: async (_argv, scratch) => {
        seen.push(scratch.root);
        expect(basename(scratch.root).startsWith("run-")).toBe(true);
        expect(scratch.env.TMPDIR).toBe(scratch.root);
        expect(scratch.env.TMP).toBe(scratch.root);
        expect(scratch.env.TEMP).toBe(scratch.root);
        return { interrupted: false, code: 0, signal: null };
      },
    });
    expect(settled.exitCode).toBe(0);
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    expect(dirname(seen[0]!)).toBe(dirname(seen[1]!));
    expect(existsSync(seen[0]!)).toBe(false);
    expect(existsSync(seen[1]!)).toBe(false);
  });
});
