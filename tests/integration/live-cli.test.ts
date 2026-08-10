import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execute } from "../../src/cli.js";

const terminalList = JSON.stringify({ ok: true, result: { terminals: [{ handle: "terminal", ptyId: "pty", incarnationId: "incarnation", worktreeId: "worktree", worktreePath: null, title: "Codex", connected: true, writable: true, lastOutputAt: null, preview: null }] } });
const terminalRead = JSON.stringify({ ok: true, result: { terminal: { handle: "terminal", status: "ok", tail: [], truncated: false, limited: false, oldestCursor: null, nextCursor: "cursor-1", latestCursor: "cursor-1", returnedLineCount: 0 } } });
const runner = async (args: readonly string[]) => args[1] === "list" ? terminalList : terminalRead;

describe("live supervisor CLI", () => {
  it("registers a bound project, reports exactly once, and remains read-only on unchanged cycles", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-live-cli-")); const worktree = join(root, "worktree"); mkdirSync(worktree); const db = join(root, "authority.sqlite"); const binding = join(root, "binding.json"); writeFileSync(binding, JSON.stringify({ worktree, provider: "codex", terminal_id: "terminal", session_id: "session", incarnation_id: "incarnation", pty_id: "pty", worktree_id: "worktree", project_id: "project" }));
    await execute(["db", "migrate", "--db", db]);
    expect(await execute(["project", "register", binding, "--db", db])).toMatchObject({ command: "project.register", project: { canonical_path: realpathSync(worktree), provider: "codex" } });
    expect((await execute(["project", "list", "--db", db])).projects).toHaveLength(1);
    const first = await execute(["supervisor", "once", "--db", db], { orcaRunner: runner }); expect(first.command).toBe("supervisor.once"); const report = first.report as { report_id: string }; expect(report.report_id).toMatch(/^live_report_/); expect(first.authority_items).toHaveLength(0);
    expect(await execute(["report", "ack", report.report_id, "--db", db])).toMatchObject({ command: "report.ack" });
    const unchanged = await execute(["supervisor", "once", "--db", db], { orcaRunner: runner }); expect(unchanged.report).toBeNull(); expect((await execute(["report", "status", "--db", db])).status).toMatchObject({ reports_pending: 0, reports_delivered: 1 });
    expect(await execute(["capabilities", "--json", "--db", db])).toMatchObject({ codex_observe: true, claude_observe: true, live_resume: false, gjc: false }); rmSync(root, { recursive: true, force: true });
  });
});
