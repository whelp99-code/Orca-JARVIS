import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

it("reports the refresh the provider published at the receipt path it is given", () => {
  // Given: a provider release that published a completed refresh receipt.
  const directory = root();
  const receipt = join(directory, "refresh-receipt.json");
  writeFileSync(receipt, `${JSON.stringify({
    schema_version: 1, profile: "daily-refresh-receipt-v1",
    receipt: { schema_version: 1, refresh_id: "262285d94b7d", state: "completed",
      completed_at: new Date(Date.now() - 60_000).toISOString(), protocol_version: 1, capped: false },
  })}\n`, { mode: 0o600 });
  // When: the compiled CLI is pointed at that receipt.
  const output = execFileSync(process.execPath,
    [resolve("dist/src/cli.js"), "second-brain", "readiness", "--json", "--refresh-receipt", receipt], {
      cwd: directory, encoding: "utf8", timeout: 60000,
      env: { ...process.env, JARVIS_DB: undefined, JARVIS_SECOND_BRAIN_LAUNCHER: join(directory, "absent-launcher") },
    });
  // Then: the completion instant the provider published is reported, and the refresh is fresh -
  // even though the provider endpoint itself is absent, because a receipt is a file it left behind.
  const report = JSON.parse(output);
  expect(report.second_brain.stages.last_successful_refresh).toMatchObject({
    state: "current_date", reason: "refresh_current_date", latest_attempt: "success",
  });
  expect(report.second_brain.stages.freshness).toMatchObject({ state: "fresh" });
  expect(readdirSync(directory).sort()).toEqual(["refresh-receipt.json"]);
});

it("refuses database, mutation and extra arguments on the readiness probe", async () => {
  // Given: the probe is a pure read of the provider endpoint.
  for (const args of [["second-brain", "readiness", "--db", "/nonexistent/authority.sqlite"],
    ["second-brain", "readiness", "--once"], ["second-brain", "readiness", "extra"], ["second-brain", "probe"],
    ["second-brain", "readiness", "--refresh-receipt", "relative/receipt.json"]]) {
    // Then: every other form is refused before any database path is opened.
    await expect(execute(args, { secondBrainProbe: passiveSecondBrainReadinessProbe() }))
      .rejects.toMatchObject({ code: "SECOND_BRAIN_READINESS_INPUT_INVALID" });
  }
});
