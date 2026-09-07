import { chmod, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { approvedTaskFixture } from "../fixtures/approved-task-fixture.js";
import { assertTaskRuntimeReady, productionTaskExecutionRuntime, taskExecutionReadiness } from "../../src/task-execution-runtime.js";
import { ClaudeTaskCandidateProvider } from "../../src/claude-task-provider.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() { const f = await approvedTaskFixture(); cleanups.push(f.cleanup); return f; }

it("does not infer executable or verifier configuration from a request or model name", async () => {
  const f = await fixture();
  expect(productionTaskExecutionRuntime({})).toBeUndefined();
  expect(productionTaskExecutionRuntime({ JARVIS_TASK_CLAUDE_PATH: "/private/cli" })).toBeUndefined();
  vi.stubEnv("JARVIS_TASK_CLAUDE_PATH", "");
  const before = f.db.db.prepare("SELECT total_changes() AS n").get();
  expect(await taskExecutionReadiness(f.db, f.plan, f.clock)).toEqual({ execution_available: false,
    readiness: { state: "unavailable", provider: "claude", authentication: "not_probed", reason_code: "TASK_EXECUTION_NOT_CONFIGURED" } });
  expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
});

it("reports Codex unsupported instead of routing it to the configured Claude provider", async () => {
  const f = await fixture();
  await expect(assertTaskRuntimeReady(f.db, { ...f.plan, provider: "codex" }, f.runtime)).rejects.toThrow("TASK_PROVIDER_UNSUPPORTED");
  expect(f.runtime.checkReady).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
});

it("rechecks a registered verifier revocation after async readiness without calling a model", async () => {
  const f = await fixture();
  f.runtime.checkReady.mockImplementation(async () => {
    f.db.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES('verifier-test','fixture',?)")
      .run(f.now.toISOString());
  });
  await expect(assertTaskRuntimeReady(f.db, f.plan, f.runtime)).rejects.toThrow("TASK_CERTIFICATION_BINDING_INVALID");
  expect(f.generate).not.toHaveBeenCalled();
});

it("checks executable permissions without executing the provider", async () => {
  const f = await fixture(); const path = join(dirname(f.db.filename), "provider-fixture");
  await writeFile(path, "#!/bin/sh\nexit 99\n", { mode: 0o600 });
  const provider = new ClaudeTaskCandidateProvider(path);
  await expect(provider.checkReady()).rejects.toThrow("TASK_PROVIDER_UNAVAILABLE");
  await chmod(path, 0o700); await expect(provider.checkReady()).resolves.toBeUndefined();
  await chmod(path, 0o720); await expect(provider.checkReady()).rejects.toThrow("TASK_PROVIDER_UNAVAILABLE");
});
