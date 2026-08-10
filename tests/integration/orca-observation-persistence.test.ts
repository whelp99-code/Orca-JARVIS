import { describe, expect, it } from "vitest";
import { AuthorityDb, observeOrca, type OrcaRunner } from "../../src/index.js";
import { execute } from "../../src/cli.js";
import type { OrcaObservationDelta, OrcaObservationSource } from "../../src/types.js";
import { tempDb } from "../helpers.js";

const terminal = (incarnationId = "incarnation-1", title = "Claude Code") => ({ handle: "terminal-1", ptyId: "pty-1", incarnationId, worktreeId: "worktree-1", worktreePath: "/repo", title, connected: true, writable: true, lastOutputAt: 1_723_215_678_901, preview: null });
const envelope = (result: Record<string, unknown>) => JSON.stringify({ id: "orca-response", ok: true, result, _meta: {} });
const list = (entry: unknown) => envelope({ terminals: [entry] });
const read = (nextCursor: string | null, limited = false, tail = ["line"]) => envelope({ terminal: { handle: "terminal-1", status: "running", tail, truncated: false, limited, oldestCursor: null, nextCursor, latestCursor: nextCursor, returnedLineCount: tail.length } });
async function database(): Promise<AuthorityDb> { const db = new AuthorityDb(tempDb()); await db.migrate(); return db; }

describe("Orca observation persistence", () => {
  it("continues from a persisted cursor and resets it when the incarnation changes", async () => {
    const db = await database(); const calls: string[][] = []; let phase = 0;
    const runner: OrcaRunner = async args => { calls.push([...args]); if (args[1] === "list") return list(terminal(phase === 2 ? "incarnation-2" : "incarnation-1")); if (phase === 0) return read("cursor-1"); if (phase === 1) return read("cursor-2"); return read("cursor-3"); };
    await observeOrca(db, { worktree: "chosen", runner }); phase = 1; await observeOrca(db, { worktree: "chosen", runner }); phase = 2; const reset = await observeOrca(db, { worktree: "chosen", runner });
    expect(calls.filter(call => call[1] === "read")).toEqual([["terminal", "read", "--terminal", "terminal-1", "--limit", "200", "--json"], ["terminal", "read", "--terminal", "terminal-1", "--cursor", "cursor-1", "--limit", "200", "--json"], ["terminal", "read", "--terminal", "terminal-1", "--limit", "200", "--json"]]);
    expect(reset.cursors).toMatchObject([{ reset: true, next_cursor: "cursor-3" }]); expect(db.getOrcaObservationSource("chosen", "terminal-1")).toMatchObject({ incarnation_id: "incarnation-2", next_cursor: "cursor-3" }); db.close();
  });
  it("stops bounded paging when the cursor does not advance", async () => {
    const db = await database(); const calls: string[][] = []; let reads = 0;
    const runner: OrcaRunner = async args => { calls.push([...args]); if (args[1] === "list") return list(terminal()); reads++; return reads === 1 ? read("cursor-1", true) : read("cursor-1", true); };
    const result = await observeOrca(db, { runner, maxPages: 5 }); db.close();
    expect(result.cursors).toMatchObject([{ pages: 2, stopped_no_progress: true, next_cursor: "cursor-1" }]); expect(calls.filter(call => call[1] === "read")).toHaveLength(2);
  });
  it("replays exact observations and rejects a conflicting identity digest", async () => {
    const db = await database(); const source: OrcaObservationSource = { worktree: "active", terminal_handle: "terminal-1", provider: "codex", incarnation_id: "incarnation-1", next_cursor: "cursor-1" };
    const delta: OrcaObservationDelta = { identity: "fixed-identity", worktree: "active", terminal_handle: "terminal-1", provider: "codex", incarnation_id: "incarnation-1", cursor_before: null, cursor_after: "cursor-1", tail: ["first"], truncated: false, limited: false, oldest_cursor: null, latest_cursor: "cursor-1", returned_line_count: 1, observed_at: "2026-08-09T00:00:00.000Z" };
    expect(db.recordOrcaObservations(source, [delta])).toEqual({ inserted: 1, replayed: 0 }); expect(db.recordOrcaObservations(source, [delta])).toEqual({ inserted: 0, replayed: 1 }); expect(() => db.recordOrcaObservations(source, [{ ...delta, cursor_after: "conflicting-cursor" }])).toThrow(); try { db.recordOrcaObservations(source, [{ ...delta, cursor_after: "conflicting-cursor" }]); } catch (error) { expect(error).toMatchObject({ code: "ORCA_OBSERVATION_REPLAY_CONFLICT" }); } expect((db.db.prepare("SELECT COUNT(*) AS n FROM orca_observation_deltas").get() as { n: number }).n).toBe(1); db.close();
  });
  it("rejects a provider rebind for the same incarnation but permits a new incarnation", async () => {
    const db = await database(); let incarnation = "incarnation-1"; const runner: OrcaRunner = async args => args[1] === "list" ? list(terminal(incarnation, "neutral")) : read("cursor-1");
    await observeOrca(db, { runner, bindings: { "terminal-1": "codex" } }); await expect(observeOrca(db, { runner, bindings: { "terminal-1": "claude" } })).rejects.toMatchObject({ code: "ORCA_SOURCE_BINDING_CONFLICT" }); incarnation = "incarnation-2"; const result = await observeOrca(db, { runner, bindings: { "terminal-1": "claude" } }); expect(result.cursors).toMatchObject([{ reset: true }]); expect(db.getOrcaObservationSource("active", "terminal-1")).toMatchObject({ provider: "claude", incarnation_id: "incarnation-2" }); db.close();
  });
  it("exposes only the read-only observation summary through the CLI module API", async () => {
    const db = await database(); const runner: OrcaRunner = async args => args[1] === "list" ? list(terminal()) : read("cursor-1");
    const result = await execute(["--db", db.filename, "observe", "orca", "--worktree", "chosen", "--limit", "3", "--max_pages", "2"], { orcaRunner: runner }); db.close();
    expect(result).toMatchObject({ ok: true, command: "observe.orca", worktree: "chosen", classified: [{ handle: "terminal-1", provider: "claude" }], inserted_deltas: 1, replayed_deltas: 0, cursors: [{ next_cursor: "cursor-1" }] });
  });
});
