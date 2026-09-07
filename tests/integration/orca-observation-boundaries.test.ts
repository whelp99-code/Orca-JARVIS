import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { GjcCoordinatorClient } from "../../src/gjc.js";
import { GjcRuntimeService } from "../../src/service.js";
import { observeBound } from "../../src/cli-live-commands.js";
import { discoverOrcaBindings } from "../../src/orca.js";
import type { LiveBinding, LiveObservation } from "../../src/live-supervisor.js";
import { tempDb } from "../helpers.js";

const envelope = (result: unknown): string => JSON.stringify({ ok: true, result });
const rejection = (code: string): string => JSON.stringify({ ok: false, error: { code, message: "fixture" } });
const binding: LiveBinding = { canonical_path: process.cwd(), provider: "codex", terminal_id: "term",
  incarnation_id: "inc", pty_id: "pty", worktree_id: "wt", session_id: "session", cursor: "previous" };
const listed = envelope({ terminals: [{ handle: "term", incarnationId: "inc", ptyId: "pty", worktreeId: "wt",
  worktreePath: process.cwd(), connected: true, writable: true, title: null, preview: null, lastOutputAt: null }] });
const reply = (body: unknown) => ({ stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1,
  result: { protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" } } })}\n${JSON.stringify({
  jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(body) }] },
})}\n`, exitCode: 0 });

describe("Orca observation failure boundaries", () => {
  it.each([
    ["runtime_unavailable", "ORCA_CLI_UNAVAILABLE", true], ["runtime_timeout", "ORCA_CLI_TIMEOUT", true],
    ["permission_denied", "ORCA_PERMISSION_DENIED", false], ["terminal_handle_stale", "ORCA_TERMINAL_STALE", false],
    ["invalid_runtime_response", "ORCA_CLI_SCHEMA_INVALID", false], ["unknown", "ORCA_CLI_REJECTED", false],
  ] as const)("isolates %s only when it proves a transport outage", async (code, expected, transient) => {
    for (const stage of ["list", "read"]) {
      const db = new AuthorityDb(tempDb()); await db.migrate(); db.configureGjc(process.cwd(), "s", true);
      const intent = db.createGjcIntent("sync", { session_id: "s", turn_id: "t" }, `sync-${stage}`);
      const calls: string[] = []; const reads: string[] = []; let observations: readonly LiveObservation[] | undefined;
      const client = new GjcCoordinatorClient(async run => {
        const name = JSON.parse(run.stdin.trim().split("\n")[2]!).params.name; calls.push(name);
        return name === "gjc_coordinator_read_turn" ? reply({ ok: true, turn: { status: "completed", session_id: "s", turn_id: "t" } })
          : reply({ questions: [] });
      });
      const service = new GjcRuntimeService(db, client, "observation-test", async () => {
        observations = await observeBound(binding, async args => {
          reads.push(args[1]!); return stage === "read" && args[1] === "list" ? listed : rejection(code);
        });
      });
      try {
        if (transient) {
          await expect(service.once()).resolves.toMatchObject({ processed: intent, state: "completed" });
          expect(calls).toEqual(["gjc_coordinator_read_turn", "gjc_coordinator_list_questions"]);
          expect(observations).toEqual([{ provider: "codex", terminal_id: "term", session_id: "session",
            incarnation_id: "inc", cursor: "previous", state: "unknown" }]);
        } else {
          await expect(service.once()).rejects.toMatchObject({ code: expected });
          expect(calls).toEqual([]);
          expect(db.db.prepare("SELECT state FROM gjc_intents WHERE intent_id=?").get(intent)).toEqual({ state: "pending" });
        }
        expect(reads).toEqual(stage === "list" ? ["list"] : ["list", "read"]);
      } finally { service.close(); db.close(); }
    }
  });

  it.each(["remote", "idle"])("does not hide fatal discovery errors for %s paths", async path => {
    for (const [code, expected] of [["permission_denied", "ORCA_PERMISSION_DENIED"],
      ["terminal_handle_stale", "ORCA_TERMINAL_STALE"], ["runtime_timeout", null]] as const) {
      const worktrees = envelope({ worktrees: [{ cwd: process.cwd(), agents: [
        { agentType: "codex", paneKey: "tab:leaf", state: "idle", updatedAt: 1 },
      ] }] });
      const discovery = discoverOrcaBindings({ environment: path === "remote" ? "jm-server" : "local",
        tolerateRemoteFailure: true, runner: async args => path === "idle" && args[0] === "worktree" ? worktrees : rejection(code) });
      if (expected === null) await expect(discovery).resolves.toEqual([]);
      else await expect(discovery).rejects.toMatchObject({ code: expected });
    }
  });
});
