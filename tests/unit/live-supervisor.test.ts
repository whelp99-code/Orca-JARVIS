import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { LiveSupervisor } from "../../src/live-supervisor.js";
import { tempDb } from "../helpers.js";

async function opened() { const db = new AuthorityDb(tempDb()); await db.migrate(); return { db, supervisor: new LiveSupervisor(db) }; }
function worktree() { return mkdtempSync(join(tmpdir(), "live-supervisor-")); }
const binding = (worktree: string) => ({ worktree, provider: "codex" as const, terminal_id: "terminal", session_id: "session", incarnation_id: "incarnation" });

describe("live supervisor", () => {
  it("registers only canonical absolute paths, caps at ten, and rejects active rebinds", async () => {
    const { db, supervisor } = await opened(); const root = worktree(); const alias = join(root, "alias"); mkdirSync(alias); expect(supervisor.register(binding(alias)).canonical_path).toBe(realpathSync(alias));
    expect(() => supervisor.register({ ...binding(alias), session_id: "other" })).toThrow("LIVE_BINDING_REBIND_REJECTED");
    // alias is already 1; add 9 more for the dual-env cap of 10.
    for (let n = 0; n < 9; n++) { const path = join(root, String(n)); mkdirSync(path); supervisor.register(binding(path)); }
    const overflow = join(root, "overflow"); mkdirSync(overflow); expect(() => supervisor.register(binding(overflow))).toThrow(); db.close(); rmSync(root, { recursive: true });
  });
  it("accepts remote encoded worktrees without a local mount", async () => {
    const { db, supervisor } = await opened();
    const remote = "/orca-env/jm-server/home/jm/orca/projects/jm-loop-miner";
    expect(supervisor.register({ ...binding(remote), terminal_id: "term_remote" }).canonical_path).toBe(remote);
    db.close();
  });
  it("recovers before observation and atomically records change-only reports and cursors", async () => {
    const { db, supervisor } = await opened(); const root = worktree(); const second = join(root, "second"); mkdirSync(second); supervisor.register(binding(root)); supervisor.register({ ...binding(second), terminal_id: "terminal-two" }); const observation = { ...binding(root), cursor: "1", state: "approval_required" as const };
    const first = await supervisor.cycleAll(current => [current.terminal_id === "terminal" ? observation : { ...binding(second), terminal_id: "terminal-two", cursor: "1", state: "running" as const }], "2026-08-09T00:00:00.000Z"); expect(first.report).not.toBeNull(); expect(first.authority_items).toHaveLength(0); expect(first.resume_candidates).toHaveLength(0);
    const recovered = await supervisor.cycleAll(() => { throw new Error("must not observe before recovery"); }, "2026-08-09T00:00:01.000Z"); expect(recovered.recovered_report?.report_id).toBe(first.report?.report_id); supervisor.acknowledgeReport(first.report!.report_id, "2026-08-09T00:00:01.000Z"); const unchanged = await supervisor.cycleAll(current => [current.terminal_id === "terminal" ? observation : { ...binding(second), terminal_id: "terminal-two", cursor: "1", state: "running" as const }], "2026-08-09T00:00:02.000Z"); expect(unchanged.report).toBeNull(); const filename = db.filename; db.close(); const restartDb = new AuthorityDb(filename); const restarted = new LiveSupervisor(restartDb); expect((await restarted.cycleAll(current => [current.terminal_id === "terminal" ? observation : { ...binding(second), terminal_id: "terminal-two", cursor: "1", state: "running" as const }], "2026-08-09T00:00:03.000Z")).report).toBeNull(); restartDb.close(); rmSync(root, { recursive: true });
  });
  it("reports first null cursor and same-cursor state change but suppresses exact replay", async () => {
    const { db, supervisor } = await opened(); const root = worktree(); supervisor.register(binding(root)); const first = await supervisor.cycle(root, () => [{ ...binding(root), cursor: null, state: "running" }], "2026-08-09T00:00:00.000Z"); expect(first.report).not.toBeNull(); supervisor.acknowledgeReport(first.report!.report_id, "2026-08-09T00:00:00.000Z"); const changed = await supervisor.cycle(root, () => [{ ...binding(root), cursor: null, state: "verifying" }], "2026-08-09T00:00:01.000Z"); expect(changed.report).not.toBeNull(); supervisor.acknowledgeReport(changed.report!.report_id, "2026-08-09T00:00:01.000Z"); expect((await supervisor.cycle(root, () => [{ ...binding(root), cursor: null, state: "verifying" }], "2026-08-09T00:00:02.000Z")).report).toBeNull(); db.close(); rmSync(root, { recursive: true });
  });
});
