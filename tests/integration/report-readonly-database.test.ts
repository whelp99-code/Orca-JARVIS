import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { execute } from "../../src/cli.js";

it.each(["task-performance", "routing-shadow"])("keeps a DELETE-journal DB unchanged for report %s", async report => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-report-readonly-"));
  const path = join(root, "authority.sqlite");
  const db = new AuthorityDb(path, "migrations");
  try {
    await db.migrate(); db.db.pragma("journal_mode=DELETE"); db.close();
    const policy = join(root, "policy.json");
    writeFileSync(policy, JSON.stringify({ schema_version: 1, policy_id: "test", revision: 1,
      rules: [{ id: "code", keywords: ["fix"], executor_ids: ["claude"], record_stores: ["second-brain"] }] }));
    const before = readFileSync(path);
    const args = ["report", report, "2026-09-08T00:00:00.000Z", "2026-09-09T00:00:00.000Z",
      ...(report === "routing-shadow" ? [policy, policy] : []), "--db", path];
    const result = await execute(args, { clock: () => new Date("2026-09-09T01:00:00.000Z") });
    expect(result).toMatchObject({ ok: true, command: `report.${report}` });
    expect(readFileSync(path).equals(before)).toBe(true);
  } finally { if (db.db.open) db.close(); rmSync(root, { recursive: true, force: true }); }
});
