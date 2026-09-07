import { describe, expect, it } from "vitest";
import { AuthorityDb, discoverOrcaBindings, OrcaReadonlyAdapter, observeOrca, type OrcaRunner } from "../../src/index.js";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { tempDb } from "../helpers.js";

const terminal = (overrides: Record<string, unknown> = {}) => ({ handle: "terminal-1", tabId: "tab", leafId: "leaf", ptyId: "pty-1", incarnationId: "incarnation-1", worktreeId: "worktree-1", worktreePath: "/repo", title: "Codex session", connected: true, writable: true, lastOutputAt: 1_723_215_678_901, preview: "ignored", ...overrides });
const envelope = (result: Record<string, unknown>, ok = true) => JSON.stringify({ id: "orca-response", ok, result, _meta: {} });
const list = (terminals: unknown[]) => envelope({ terminals });
const read = (overrides: Record<string, unknown> = {}) => envelope({ terminal: { handle: "terminal-1", status: "running", tail: ["safe bounded tail"], truncated: false, limited: false, oldestCursor: null, nextCursor: "cursor-1", latestCursor: "cursor-1", returnedLineCount: 1, ...overrides } });

async function database(): Promise<AuthorityDb> { const db = new AuthorityDb(tempDb()); await db.migrate(); return db; }

describe("Orca read-only adapter", () => {
  it("discovers up to five exact structured pane bindings without titles or prose", async () => {
    const root = mkdtempSync(`${tmpdir()}/orca-discover-`); const calls: string[][] = [];
    const runner: OrcaRunner = async args => { calls.push([...args]); if (args[0] === "worktree") return envelope({ worktrees: [{ cwd: root, agents: [{ agentType: "codex", paneKey: "tab:leaf", state: "working", updatedAt: 2 }, { agentType: "claude", paneKey: "tab2:leaf2", state: "idle", stateStartedAt: 1 }] }] }); return list([terminal({ handle: "term_a", title: "not inspected", preview: "not inspected" }), terminal({ handle: "term_b", tabId: "tab2", leafId: "leaf2", incarnationId: "i2", ptyId: "p2", title: "not inspected", preview: "not inspected" })]); };
    await expect(discoverOrcaBindings(runner)).resolves.toMatchObject([{ terminal_id: "term_a", provider: "codex", session_id: "incarnation-1" }, { terminal_id: "term_b", provider: "claude", session_id: "i2" }]); expect(calls).toEqual([["worktree", "ps", "--json"], ["terminal", "list", "--worktree", realpathSync(root), "--json"]]);
  });
  it("fails closed for pane mismatch or unmatched pane", async () => {
    const root = mkdtempSync(`${tmpdir()}/orca-discover-`); const mismatch: OrcaRunner = async () => envelope({ worktrees: [{ cwd: root, agents: [{ agentType: "codex", paneKey: "wrong", tabId: "tab", leafId: "leaf", state: "working", updatedAt: 1 }] }] }); await expect(discoverOrcaBindings(mismatch)).rejects.toMatchObject({ code: "ORCA_PANE_BINDING_INVALID" });
    const unmatched: OrcaRunner = async args => args[0] === "worktree" ? envelope({ worktrees: [{ cwd: root, agents: [{ agentType: "codex", paneKey: "tab:leaf", state: "working", updatedAt: 1 }] }] }) : list([]); await expect(discoverOrcaBindings(unmatched)).rejects.toMatchObject({ code: "ORCA_PANE_BINDING_UNMATCHED" });
  });
  it("skips stale non-working panes but rejects an unmatched working pane", async () => { const root = mkdtempSync(`${tmpdir()}/orca-discover-`); const agents = ["a:x", "b:x", "c:x", "stale:x", "d:x"].map((paneKey, index) => ({ agentType: index === 1 || index === 3 ? "claude" : "codex", paneKey, state: index < 3 ? "working" : "done", updatedAt: 5 - index })); const runner: OrcaRunner = async args => args[0] === "worktree" ? envelope({ worktrees: [{ cwd: root, agents }] }) : list([terminal({ handle: "term_a", tabId: "a", leafId: "x" }), terminal({ handle: "term_b", tabId: "b", leafId: "x" }), terminal({ handle: "term_c", tabId: "c", leafId: "x" }), terminal({ handle: "term_d", tabId: "d", leafId: "x" })]); await expect(discoverOrcaBindings(runner)).resolves.toHaveLength(4); const workingMiss: OrcaRunner = async args => args[0] === "worktree" ? envelope({ worktrees: [{ cwd: root, agents: [{ agentType: "codex", paneKey: "missing:x", state: "working", updatedAt: 1 }] }] }) : list([]); await expect(discoverOrcaBindings(workingMiss)).rejects.toMatchObject({ code: "ORCA_PANE_BINDING_UNMATCHED" }); });
  it("stops terminal listing after five valid panes and skips stale listing failures", async () => { const root = mkdtempSync(`${tmpdir()}/orca-lazy-`); const later = mkdtempSync(`${tmpdir()}/orca-later-`); const agents = [0, 1, 2, 3, 4].map(n => ({ agentType: "codex", paneKey: `p${n}:x`, state: "working", updatedAt: 10 - n })); const calls: string[][] = []; const runner: OrcaRunner = async args => { calls.push([...args]); if (args[0] === "worktree") return envelope({ worktrees: [{ cwd: root, agents }, { cwd: later, agents: [{ agentType: "codex", paneKey: "later:x", state: "done", updatedAt: 0 }] }] }); if (args[3] === later) throw new Error("must not list later"); return list(agents.map((agent, n) => terminal({ handle: `term_${n}`, tabId: agent.paneKey.split(":")[0], leafId: "x" }))); }; await expect(discoverOrcaBindings(runner)).resolves.toHaveLength(5); expect(calls.filter(call => call[0] === "terminal")).toHaveLength(1); });
  it("uses only exact list/read commands and fails closed for ambiguous titles", async () => {
    const calls: string[][] = []; const runner: OrcaRunner = async args => { calls.push([...args]); return args[1] === "list" ? list([terminal({ title: "Codex and Claude" })]) : read(); };
    const db = await database(); const result = await observeOrca(db, { worktree: "selected", runner }); db.close();
    expect(result.classified).toEqual([]); expect(result.unclassified).toMatchObject([{ handle: "terminal-1", title: "Codex and Claude" }]); expect(calls).toEqual([["terminal", "list", "--worktree", "selected", "--json"]]);
  });
  it("honors explicit bindings without inspecting preview content", async () => {
    const calls: string[][] = []; const runner: OrcaRunner = async args => { calls.push([...args]); return args[1] === "list" ? list([terminal({ title: "neutral", preview: "claude codex" })]) : read(); };
    const db = await database(); const result = await observeOrca(db, { runner, bindings: { "terminal-1": "claude" }, limit: 7 }); db.close();
    expect(result.classified).toMatchObject([{ handle: "terminal-1", provider: "claude" }]); expect(calls).toEqual([["terminal", "list", "--worktree", "active", "--json"], ["terminal", "read", "--terminal", "terminal-1", "--limit", "7", "--json"]]);
  });
  it("accepts the real envelope with epoch timestamps and leaves a null title unclassified", async () => {
    const adapter = new OrcaReadonlyAdapter(async () => list([terminal({ title: null, lastOutputAt: null })])); const listed = await adapter.list("active"); expect(listed).toMatchObject([{ title: null, lastOutputAt: null }]);
    const db = await database(); const result = await observeOrca(db, { runner: async args => args[1] === "list" ? list([terminal({ title: null, lastOutputAt: 1_723_215_678_901 })]) : read() }); db.close(); expect(result).toMatchObject({ classified: [], unclassified: [{ handle: "terminal-1", title: null }] });
  });
  it("rejects bad production envelopes", async () => {
    const db = await database(); await expect(observeOrca(db, { runner: async () => envelope({ terminals: [] }, false) })).rejects.toMatchObject({ code: "ORCA_CLI_SCHEMA_INVALID" }); await expect(observeOrca(db, { runner: async () => JSON.stringify({ id: "orca-response", ok: true, version: 2, result: { terminals: [] }, _meta: {} }) })).rejects.toMatchObject({ code: "ORCA_CLI_SCHEMA_INVALID" }); db.close();
  });
});
