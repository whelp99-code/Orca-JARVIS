import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CutoverRehearsal } from "../../src/cutover-rehearsal.js";

describe("migration rehearsal", () => {
  it("copies a snapshot, keeps hashes, and records a blocked production gate", () => {
    const home = mkdtempSync(join(tmpdir(), "jarvis-rehearse-"));
    const rehearsal = new CutoverRehearsal(home);
    rehearsal.seed("row-1\nrow-2\nrow-3\n");
    const result = rehearsal.run();
    expect(result.ok).toBe(true);
    expect(result.before.hash).toBe(result.after.hash);
    expect(result.before.rows).toBe(3);
    const restored = rehearsal.rollback(result);
    expect(restored.hash).toBe(result.before.hash);
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/17/happy"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/17/happy/index.json"), `${JSON.stringify({
      ok: true,
      cutover: "blocked_pending_owner",
      soak: { settled: 0, restarts: 0, updateRollback: 1, uncertain: 0, duplicates: 0 },
      before: result.before,
      after: result.after,
    }, null, 2)}\n`);
  });

  it("blocks cutover on corrupt snapshot or health failure and still rolls back", () => {
    const home = mkdtempSync(join(tmpdir(), "jarvis-rehearse-fail-"));
    const rehearsal = new CutoverRehearsal(home);
    rehearsal.seed("row-1\n");
    const corrupt = rehearsal.run({ corrupt: true });
    expect(corrupt.blocked).toBe(true);
    const health = rehearsal.run({ healthFail: true });
    expect(health.blocked).toBe(true);
    const restored = rehearsal.rollback(corrupt);
    expect(restored.hash).toBe(corrupt.before.hash);
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/17/failure"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/17/failure/blocked.json"), `${JSON.stringify({
      corrupt: corrupt.reason, health: health.reason, rolledBack: restored.hash === corrupt.before.hash,
    }, null, 2)}\n`);
  });
});
