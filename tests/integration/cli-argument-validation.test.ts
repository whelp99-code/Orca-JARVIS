import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { execute } from "../../src/cli.js";

it("rejects unknown or malformed options before creating a database or dispatching", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-cli-arguments-"));
  try {
    const database = join(root, "missing.sqlite");
    for (const args of [
      ["timeline", "context", "task", "--max-bytes", "1048576"],
      ["init", "--unexpected-secret=value-that-must-not-be-echoed"],
      ["service", "once", "--remote-audit-retention-limt", "10"],
      ["service", "once", "--once=false"],
      ["timeline", "context", "task", "--limit"],
    ]) {
      await expect(execute(["--db", database, ...args])).rejects.toMatchObject({
        code: "CLI_ARGUMENT_INVALID", message: "CLI_ARGUMENT_INVALID",
      });
      expect(existsSync(database)).toBe(false);
    }
    expect(await execute(["routing", "templates", "--json"]))
      .toMatchObject({ ok: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
