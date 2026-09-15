import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { passiveSecondBrainReadinessProbe } from "../../src/second-brain-readiness.js";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "jarvis-sb-readiness-")); roots.push(value); return value;
}
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

it("reports second-brain readiness without resolving or creating an authority database", () => {
  // Given: a working directory with no database and no JARVIS_DB pointing at one.
  const directory = root();
  // When: the compiled CLI is asked for readiness the way an operator asks from the release root.
  const output = execFileSync(process.execPath, [resolve("dist/src/cli.js"), "second-brain", "readiness", "--json"], {
    cwd: directory, encoding: "utf8", timeout: 60000,
    env: { ...process.env, JARVIS_DB: undefined, JARVIS_SECOND_BRAIN_LAUNCHER: join(directory, "absent-launcher") },
  });
  // Then: a readiness report is printed, and no stray empty authority database is left behind to
  // be reported as MIGRATIONS_PENDING.
  expect(JSON.parse(output)).toMatchObject({
    ok: true, command: "second-brain.readiness",
    second_brain: { capability: "second_brain", schema_version: 1 },
  });
  expect(readdirSync(directory)).toEqual([]);
});

it("refuses database, mutation and extra arguments on the readiness probe", async () => {
  // Given: the probe is a pure read of the provider endpoint.
  for (const args of [["second-brain", "readiness", "--db", "/nonexistent/authority.sqlite"],
    ["second-brain", "readiness", "--once"], ["second-brain", "readiness", "extra"], ["second-brain", "probe"]]) {
    // Then: every other form is refused before any database path is opened.
    await expect(execute(args, { secondBrainProbe: passiveSecondBrainReadinessProbe() }))
      .rejects.toMatchObject({ code: "SECOND_BRAIN_READINESS_INPUT_INVALID" });
  }
});
