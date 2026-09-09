import { expect, it, vi } from "vitest";
import { probeTaskExecutorRuntime } from "../../src/task-executor-registry.js";
import { ClaudeTaskCandidateProvider } from "../../src/claude-task-provider.js";
import { JarvisError } from "../../src/db.js";

it("does not construct a runnable probe for unregistered or incomplete configuration", async () => {
  const ready = vi.spyOn(ClaudeTaskCandidateProvider.prototype, "checkReady");
  const generate = vi.spyOn(ClaudeTaskCandidateProvider.prototype, "generate");
  try {
    expect(await probeTaskExecutorRuntime("unknown", {})).toMatchObject({ execution_available: false,
      readiness: { state: "not_probed", reason_code: "TASK_EXECUTOR_UNREGISTERED" } });
    expect(await probeTaskExecutorRuntime("claude-code", {})).toMatchObject({ execution_available: false,
      authentication: "not_probed", readiness: { state: "not_probed", reason_code: "TASK_EXECUTOR_CONFIGURATION_MISSING" } });
    expect(ready).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  } finally { ready.mockRestore(); generate.mockRestore(); }
});

it.each([new Error("private-secret-path"), new JarvisError("TASK_PROVIDER_UNAVAILABLE")])(
  "returns bounded preflight failures without raw diagnostics", async error => {
    const ready = vi.spyOn(ClaudeTaskCandidateProvider.prototype, "checkReady").mockRejectedValue(error);
    try {
      const result = await probeTaskExecutorRuntime("claude-code", { JARVIS_TASK_CLAUDE_PATH: "/private/provider",
        JARVIS_TASK_VERIFIER_KEY_PATH: "/private/key", JARVIS_TASK_VERIFIER_KEY_ID: "private-id" });
      expect(result).toMatchObject({ execution_available: false, authentication: "not_probed",
        readiness: { state: "unavailable", remote_verification: "not_performed" } });
      expect(JSON.stringify(result)).not.toMatch(/private-secret-path|\/private\/|private-id/);
    } finally { ready.mockRestore(); }
  });
