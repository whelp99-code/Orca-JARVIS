#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { backendShardRuns, backendShardsRunInParallel } from "./lib/backend-shard-plan.mjs";
import { createTestEnvironment } from "./lib/test-environment.mjs";
import { runTestProcess } from "./lib/test-process.mjs";

const [profile, ...args] = process.argv.slice(2);
const profiles = ["backend", "unit", "integration", "dashboard", "gui", "e2e", "acceptance", "smoke"];
let scratch;
const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGINT", abort); process.once("SIGTERM", abort);

async function runOnce(command, argv, env, options) {
  const result = await runTestProcess(command, argv, { env, signal: controller.signal, ...options });
  if (result.timedOut) throw new Error(options.profile === "gui" ? "TEST_GUI_TIMEOUT" : "TEST_RUN_TIMEOUT");
  if (result.spawnError) throw new Error("TEST_COMMAND_UNAVAILABLE");
  if (result.interrupted) return { interrupted: true, code: 130 };
  return { interrupted: false, code: result.code ?? 0 };
}

try {
  if (!profiles.includes(profile)) throw new Error("TEST_PROFILE_INVALID");
  let command = process.execPath;
  let argv = [resolve("node_modules/vitest/vitest.mjs"), "run", ...args];
  let readyMarker;
  if (profile === "dashboard") argv.splice(2, 0, "--config", "dashboard/vite.config.ts", "--no-file-parallelism");
  if (profile === "e2e") argv = [resolve("node_modules/@playwright/test/cli.js"), "test",
    "e2e/control-center.spec.ts", "e2e/task-lineage.spec.ts", "e2e/sse-recovery.spec.ts", ...args];
  if (profile === "acceptance") argv = [resolve("scripts/pre-gjc-acceptance.mjs"), ...args];
  if (profile === "smoke") argv = [resolve("scripts/cli-smoke.mjs"), ...args];
  if (profile === "gui") {
    readyMarker = "JARVIS_GUI_DISPLAY_READY";
    argv = [resolve("scripts/gui-test-entry.mjs"), ...args];
  }

  const runs = backendShardRuns(profile, args, argv);
  const parallelShards = backendShardsRunInParallel(profile, args);
  scratch = parallelShards ? null : createTestEnvironment();
  const sharedEnv = scratch ? { ...scratch.env, JARVIS_TEST_PROFILE: profile } : null;

  if (profile === "gui" && process.platform === "linux" && !sharedEnv?.DISPLAY?.trim()) {
    const privateTmp = join(scratch.root, "display-tmp"); mkdirSync(privateTmp, { mode: 0o700 });
    mkdirSync(join(privateTmp, ".X11-unix"), { mode: 0o1777 });
    argv = ["--die-with-parent", "--unshare-pid", "--bind", "/", "/", "--dev-bind", "/dev", "/dev",
      "--bind", privateTmp, "/tmp", "--proc", "/proc", "--", process.execPath, ...argv];
    sharedEnv.TMPDIR = "/tmp"; sharedEnv.TMP = "/tmp"; sharedEnv.TEMP = "/tmp";
    command = "bwrap";
  }

  if (profile !== "acceptance" && profile !== "smoke") process.stdout.write(`JARVIS_TEST_PROFILE ${profile}\n`);
  const processOptions = {
    profile,
    readyMarker,
    startupTimeoutMs: 15000,
    timeoutMs: profile === "gui" ? 180000 : profile === "backend" ? 2_400_000 : 1200000,
  };

  if (parallelShards) {
    process.stdout.write(`JARVIS_TEST_SHARD parallel ${runs.length}/${runs.length}\n`);
    const shardCleanups = [];
    const outcomes = await Promise.all(runs.map(async (current, index) => {
      const shardScratch = createTestEnvironment();
      shardCleanups.push(shardScratch.cleanup);
      process.stdout.write(`JARVIS_TEST_SHARD ${index + 1}/${runs.length} start\n`);
      const env = { ...shardScratch.env, JARVIS_TEST_PROFILE: profile };
      const outcome = await runOnce(command, current, env, processOptions);
      process.stdout.write(`JARVIS_TEST_SHARD ${index + 1}/${runs.length} end code=${outcome.code}\n`);
      return outcome;
    }));
    for (const cleanup of shardCleanups) cleanup();
    if (outcomes.some((outcome) => outcome.interrupted)) process.exitCode = 130;
    else if (outcomes.some((outcome) => outcome.code !== 0)) process.exitCode = outcomes.find((o) => o.code !== 0)?.code ?? 1;
    else process.exitCode ??= 0;
  } else {
    for (const [index, current] of runs.entries()) {
      if (controller.signal.aborted) { process.exitCode = 130; break; }
      if (runs.length > 1) process.stdout.write(`JARVIS_TEST_SHARD ${index + 1}/${runs.length}\n`);
      const outcome = await runOnce(command, current, sharedEnv, processOptions);
      if (outcome.interrupted) { process.exitCode = 130; break; }
      if (outcome.code !== 0) process.exitCode = outcome.code;
      else process.exitCode ??= 0;
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`); process.exitCode = 2;
} finally {
  process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
  scratch?.cleanup();
}
