import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { inspectTaskExecutor, registeredTaskExecutor } from "../../src/task-executor-registry.js";
import { productionTaskExecutionRuntime } from "../../src/task-execution-runtime.js";

it("resolves only the exact compiled provider with no fallback or mutable registration", () => {
  const env = { JARVIS_TASK_CLAUDE_PATH: "/private/cli", JARVIS_TASK_VERIFIER_KEY_PATH: "/private/key",
    JARVIS_TASK_VERIFIER_KEY_ID: "private-key-id" };
  expect(productionTaskExecutionRuntime(env, "claude")?.provider.provider).toBe("claude");
  for (const provider of ["codex", "claude-code", "Claude", "cursor", "__proto__"]) {
    expect(registeredTaskExecutor(provider)).toBeUndefined();
    expect(productionTaskExecutionRuntime(env, provider)).toBeUndefined();
  }
  const descriptor = registeredTaskExecutor("claude")!;
  expect(() => Reflect.set(descriptor, "provider", "codex")).not.toThrow();
  expect(descriptor.provider).toBe("claude");
  expect(Object.isFrozen(descriptor.required_configuration)).toBe(true);
});

it("reports missing configuration names without interpreting registration as readiness", () => {
  expect(inspectTaskExecutor("claude-code", {})).toMatchObject({ registration: "registered", configuration: "missing",
    execution_available: false, readiness: "not_probed", authentication: "not_probed",
    missing_configuration: ["JARVIS_TASK_CLAUDE_PATH", "JARVIS_TASK_VERIFIER_KEY_PATH", "JARVIS_TASK_VERIFIER_KEY_ID"] });
  expect(inspectTaskExecutor("cursor", {})).toEqual({ schema_version: 1, id: "cursor", registration: "unregistered",
    execution_available: false, readiness: "not_probed", authentication: "not_probed" });
});

it("runs compiled inspection without executing a configured provider, leaking values or creating a database", () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-executor-inspection-"));
  try {
    const path = join(root, "private-provider");
    writeFileSync(path, "#!/bin/sh\ntouch invoked\nexit 99\n", { mode: 0o700 });
    const env = { ...process.env, JARVIS_DB: join(root, "authority.sqlite"), JARVIS_TASK_CLAUDE_PATH: path,
      JARVIS_TASK_VERIFIER_KEY_PATH: join(root, "private-missing-key"), JARVIS_TASK_VERIFIER_KEY_ID: "private-key-id" };
    for (const args of [["executors"], ["executor", "claude-code"], ["executor", "mail-intelligence"]]) {
      const output = execFileSync(process.execPath, [resolve("dist/src/cli.js"), "routing", ...args, "--json"], {
        cwd: root, env, encoding: "utf8", timeout: 10000,
      });
      expect(output).not.toContain("private-"); expect(output).not.toContain(root);
      const result = JSON.parse(output);
      expect(result.ok).toBe(true);
      const items = result.executors ?? [result.executor];
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ execution_available: false, readiness: "not_probed", authentication: "not_probed" });
      if (args[1] !== "mail-intelligence") expect(items[0]).toMatchObject({ registration: "registered",
        configuration: "present", missing_configuration: [] });
      else expect(items[0].registration).toBe("unregistered");
    }
    expect(readdirSync(root)).toEqual(["private-provider"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("rejects malformed identifiers and execution or database flags before any database access", async () => {
  for (const id of ["../claude", "Claude", "a".repeat(65), "claude code"]) {
    await expect(execute(["routing", "executor", id])).rejects.toMatchObject({ code: "TASK_EXECUTOR_INPUT_INVALID" });
  }
  for (const args of [["executors", "extra"], ["executor"], ["executor", "claude-code", "--once"],
    ["executors", "--db", "/nonexistent/database.sqlite"]]) {
    await expect(execute(["routing", ...args])).rejects.toMatchObject({ code: "WORK_ROUTING_INPUT_INVALID" });
  }
});
