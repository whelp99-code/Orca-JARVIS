import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { executionPlan } from "../fixtures/task-execution-fixture.js";

it.each(["classify", "validate-plan", "compile-template"])("rejects duplicate JSON keys before %s", async command => {
  const root = mkdtempSync(join(tmpdir(), "routing-json-"));
  try {
    const path = join(root, "input.json");
    const plan = { ...executionPlan(), provider: "claude", schema_version: 2, mode: "verified_git_commit",
      repository: { root: "/nonexistent/repository", baseline_commit: "a".repeat(40) },
      publication: { ref: "refs/heads/codex/result", repository_identity: `sha256:${"d".repeat(64)}` } };
    const template = { template_id: "code-fix", revision: 1, objective: "Fix module", files: [{ path: "a.ts", access: "write" }],
      verification: [{ id: "check", argv: ["node", "--version"], cwd: ".", expected_exit: 0 }] };
    const payload = command === "classify" ? { schema_version: 1, objective: "메일 회신 초안" }
      : command === "validate-plan" ? plan : template;
    const field = command === "classify" ? "objective" : command === "validate-plan" ? "provider" : "template_id";
    const args = command === "classify" ? ["routing", command, path, resolve("config/work-routing.preview.json")]
      : command === "validate-plan" ? ["routing", command, "claude-code", path] : ["routing", command, path];
    writeFileSync(path, JSON.stringify(payload));
    await expect(execute(args)).resolves.toMatchObject({ ok: true });
    for (const key of [field, `\\u${field.charCodeAt(0).toString(16).padStart(4, "0")}${field.slice(1)}`]) {
      writeFileSync(path, `{${JSON.stringify(key).replace("\\\\u", "\\u")}:"conflicting-first-value",${JSON.stringify(payload).slice(1)}`);
      await expect(execute(args)).rejects.toMatchObject({ code: "WORK_ROUTING_INPUT_INVALID" });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
