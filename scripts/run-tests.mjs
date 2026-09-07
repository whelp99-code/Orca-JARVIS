#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTestEnvironment } from "./lib/test-environment.mjs";
import { runTestProcess } from "./lib/test-process.mjs";

const [profile, ...args] = process.argv.slice(2);
const profiles = ["backend", "unit", "integration", "dashboard", "gui", "e2e", "acceptance", "smoke"];
let scratch;
const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGINT", abort); process.once("SIGTERM", abort);
try {
  if (!profiles.includes(profile)) throw new Error("TEST_PROFILE_INVALID");
  scratch = createTestEnvironment();
  const env = { ...scratch.env, JARVIS_TEST_PROFILE: profile };
  let command = process.execPath;
  let argv = [resolve("node_modules/vitest/vitest.mjs"), "run", ...args];
  let readyMarker;
  if (profile === "dashboard") argv.splice(2, 0, "--config", "dashboard/vite.config.ts", "--no-file-parallelism");
  if (profile === "e2e") argv = [resolve("node_modules/@playwright/test/cli.js"), "test", "e2e/control-center.spec.ts", ...args];
  if (profile === "acceptance") argv = [resolve("scripts/pre-gjc-acceptance.mjs"), ...args];
  if (profile === "smoke") argv = [resolve("scripts/cli-smoke.mjs"), ...args];
  if (profile === "gui") {
    readyMarker = "JARVIS_GUI_DISPLAY_READY";
    argv = [resolve("scripts/gui-test-entry.mjs"), ...args];
    if (process.platform === "linux" && !env.DISPLAY?.trim()) {
      const privateTmp = join(scratch.root, "display-tmp"); mkdirSync(privateTmp, { mode: 0o700 });
      mkdirSync(join(privateTmp, ".X11-unix"), { mode: 0o1777 });
      argv = ["--die-with-parent", "--unshare-pid", "--bind", "/", "/", "--dev-bind", "/dev", "/dev",
        "--bind", privateTmp, "/tmp", "--proc", "/proc", "--", process.execPath, ...argv];
      env.TMPDIR = "/tmp"; env.TMP = "/tmp"; env.TEMP = "/tmp";
      command = "bwrap";
    }
  }
  if (profile !== "acceptance" && profile !== "smoke") process.stdout.write(`JARVIS_TEST_PROFILE ${profile}\n`);
  const result = await runTestProcess(command, argv, { env, signal: controller.signal, readyMarker,
    startupTimeoutMs: 15000, timeoutMs: profile === "gui" ? 180000 : 1200000 });
  if (result.timedOut) throw new Error(profile === "gui" ? "TEST_GUI_TIMEOUT" : "TEST_RUN_TIMEOUT");
  if (result.spawnError) throw new Error("TEST_COMMAND_UNAVAILABLE");
  process.exitCode = result.interrupted ? 130 : result.code ?? 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`); process.exitCode = 2;
} finally {
  process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
  scratch?.cleanup();
}
