import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  createOrcaRunner,
  decodeEnvWorktree,
  encodeEnvWorktree,
  LOCAL_ORCA_ENVIRONMENT,
  parseOrcaEnvironments,
  withOrcaEnvironment,
} from "../../src/orca-env.js";
import { discoverOrcaBindings, type OrcaRunner } from "../../src/orca.js";

const envelope = (result: Record<string, unknown>) => JSON.stringify({ id: "orca-response", ok: true, result, _meta: {} });

describe("orca multi-environment helpers", () => {
  it("parses environment lists with defaults and dedupe", () => {
    expect(parseOrcaEnvironments("local,jm-server,local")).toEqual(["local", "jm-server"]);
    expect(parseOrcaEnvironments("")).toEqual(["local"]);
  });

  it("encodes remote worktrees without requiring a local mount", () => {
    expect(encodeEnvWorktree("jm-server", "/home/jm/orca/projects/jm-loop-miner")).toBe(
      "/orca-env/jm-server/home/jm/orca/projects/jm-loop-miner",
    );
    expect(decodeEnvWorktree("/orca-env/jm-server/home/jm/orca/projects/jm-loop-miner")).toEqual({
      environment: "jm-server",
      orcaWorktree: "/home/jm/orca/projects/jm-loop-miner",
      listSelector: "path:/home/jm/orca/projects/jm-loop-miner",
    });
  });

  it("encodes local worktrees via realpath", () => {
    const root = mkdtempSync(`${tmpdir()}/orca-env-local-`);
    expect(encodeEnvWorktree(LOCAL_ORCA_ENVIRONMENT, root)).toBe(realpathSync(root));
    expect(decodeEnvWorktree(encodeEnvWorktree(LOCAL_ORCA_ENVIRONMENT, root)).environment).toBe("local");
  });

  it("injects --environment after the Orca command tokens", () => {
    expect(withOrcaEnvironment(["worktree", "ps", "--json"], "jm-server")).toEqual([
      "worktree", "ps", "--environment", "jm-server", "--json",
    ]);
    expect(withOrcaEnvironment(["terminal", "list", "--worktree", "path:/home/jm", "--json"], "jm-server")).toEqual([
      "terminal", "list", "--environment", "jm-server", "--worktree", "path:/home/jm", "--json",
    ]);
    expect(withOrcaEnvironment(["worktree", "ps", "--json"], "local")).toEqual(["worktree", "ps", "--json"]);
  });

  it("discovers remote panes through an environment-scoped runner", async () => {
    const remoteRoot = "/home/jm/orca/projects/jm-loop-miner";
    const calls: string[][] = [];
    const base: OrcaRunner = async args => {
      calls.push([...args]);
      if (args[0] === "worktree") {
        return envelope({
          worktrees: [{
            cwd: remoteRoot,
            agents: [{ agentType: "codex", paneKey: "tab:leaf", state: "working", updatedAt: 2 }],
          }],
        });
      }
      return envelope({
        terminals: [{
          handle: "term_remote",
          tabId: "tab",
          leafId: "leaf",
          ptyId: "pty-r",
          incarnationId: "inc-r",
          worktreeId: "wt-r",
          worktreePath: remoteRoot,
          title: "Codex",
          connected: true,
          writable: true,
          lastOutputAt: 1,
          preview: null,
        }],
      });
    };
    const runner = createOrcaRunner("jm-server", base);
    const found = await discoverOrcaBindings({ runner, environment: "jm-server", tolerateRemoteFailure: false });
    expect(found).toMatchObject([{
      terminal_id: "term_remote",
      worktree: "/orca-env/jm-server/home/jm/orca/projects/jm-loop-miner",
      provider: "codex",
    }]);
    expect(calls[0]).toEqual(["worktree", "ps", "--environment", "jm-server", "--json"]);
    expect(calls[1]).toEqual(["terminal", "list", "--environment", "jm-server", "--worktree", `path:${remoteRoot}`, "--json"]);
  });
});
