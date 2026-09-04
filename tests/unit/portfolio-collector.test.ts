import { describe, expect, it } from "vitest";
import { verifyPortfolioAuthenticatedEnvelope } from "../../src/dashboard/portfolio-auth.js";
import {
  collectPortfolioEnvelope,
  type CollectorCommandRunner,
} from "../../src/dashboard/portfolio-collector.js";
import { main } from "../../src/dashboard/portfolio-collector-main.js";
import { PORTFOLIO_AT } from "../fixtures/portfolio-report.js";

const KEY = Buffer.alloc(32, 0x42);

const ORCA_WORKTREES = JSON.stringify({
  version: 1,
  ok: true,
  result: {
    worktrees: [
      { cwd: "/repo/one", agents: [{ agentType: "codex", paneKey: "a", state: "working", updatedAt: 1 }] },
      { cwd: "/repo/two", agents: [{ agentType: "claude", paneKey: "b", state: "idle", updatedAt: 2 }] },
      { cwd: "/repo/three", agents: [{ agentType: "pi", paneKey: "c", state: "working", updatedAt: 3 }] },
    ],
  },
});

const ORCA_TERMINALS = JSON.stringify({
  version: 1,
  ok: true,
  result: { terminals: [{ handle: "t1" }, { handle: "t2" }, { handle: "t3" }] },
});

const GH_RESPONSE = JSON.stringify({
  data: {
    r0: { issues: { totalCount: 5 }, pullRequests: { totalCount: 2 } },
    r1: { issues: { totalCount: 3 }, pullRequests: { totalCount: 1 } },
  },
});

const REPOSITORIES_MANIFEST = JSON.stringify({
  schema_version: 1,
  repositories: ["whelp99-code/A", "whelp99-code/B"],
});

const STATUS_MANIFEST = JSON.stringify({
  schema_version: 1,
  milestones: [{ title: "Milestone one", state: "in_progress" }],
  blockers: [{ title: "Blocker one", kind: "approval_required" }],
});

function options(overrides: {
  readonly orcaRunner?: CollectorCommandRunner;
  readonly gitRunner?: CollectorCommandRunner;
  readonly ghRunner?: CollectorCommandRunner;
  readonly source?: "local" | "jm-server";
} = {}) {
  const calls: string[][] = [];
  const git: CollectorCommandRunner = async (args) => {
    calls.push(["git", ...args]);
    const path = args[1];
    if (path === "/repo/one") return " M src/a.ts\n?? new.txt\n";
    if (path === "/repo/two") return "";
    if (path === "/repo/three") return " M b.ts\n";
    throw new Error(`unexpected git path ${String(path)}`);
  };
  return {
    calls,
    input: {
      source: (overrides.source ?? "local") as "local" | "jm-server",
      scopeFile: overrides.source === "jm-server" ? null : "repositories.json",
      statusFile: overrides.source === "jm-server" ? null : "status.json",
      orcaRunner: overrides.orcaRunner ?? (async (args) => {
        calls.push(["orca", ...args]);
        if (args[0] === "worktree") return ORCA_WORKTREES;
        if (args[0] === "terminal") return ORCA_TERMINALS;
        throw new Error("unexpected orca args");
      }),
      ghRunner: overrides.ghRunner ?? (async (args) => {
        calls.push(["gh", ...args]);
        if (args[0] === "api" && args[1] === "graphql") return GH_RESPONSE;
        throw new Error("unexpected gh args");
      }),
      gitRunner: overrides.gitRunner ?? git,
      readFile: async (path: string) => {
        if (path === "repositories.json") return REPOSITORIES_MANIFEST;
        if (path === "status.json") return STATUS_MANIFEST;
        throw new Error(`unexpected file ${path}`);
      },
      clock: () => new Date(PORTFOLIO_AT),
    },
  };
}

describe("portfolio collector", () => {
  it("collects a measured LOCAL report from actual command output and signs it", async () => {
    const { calls, input } = options();
    const envelope = await collectPortfolioEnvelope(input, KEY);
    const report = envelope.report;
    if ("collector_status" in report) throw new Error("expected report, not error");
    if (report.source !== "local") throw new Error("expected local report");
    expect(report.reported_at).toBe(PORTFOLIO_AT);
    expect(report.host).toEqual({
      worktree_count: 3,
      terminal_count: 3,
      clean_count: 1,
      dirty_count: 2,
      dirty_path_count: 3,
      active_task_count: 2,
    });
    expect(report.github).toEqual({ issue_count: 8, pull_request_count: 3 });
    expect(report.milestones).toEqual([{ title: "Milestone one", state: "in_progress" }]);
    expect(report.blockers).toEqual([{ title: "Blocker one", kind: "approval_required" }]);
    expect(calls).toContainEqual(["orca", "worktree", "ps", "--json"]);
    expect(calls).toContainEqual(["orca", "terminal", "list", "--json"]);
    expect(calls).toContainEqual(["git", "-C", "/repo/one", "status", "--porcelain=v1"]);
    const ghCalls = calls.filter((call) => call[0] === "gh");
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]?.[1]).toBe("api");
    expect(ghCalls[0]?.[2]).toBe("graphql");
    expect(ghCalls[0]?.join(" ")).toContain("repository(owner:");
    const payload = verifyPortfolioAuthenticatedEnvelope(Buffer.from(JSON.stringify(envelope), "utf8"), KEY, "local");
    expect(JSON.parse(payload.toString("utf8"))).toEqual(report);
  });

  it("emits a host-only JM report without manifests or github", async () => {
    const { input } = options({ source: "jm-server" });
    const envelope = await collectPortfolioEnvelope(input, KEY);
    const report = envelope.report;
    if ("collector_status" in report) throw new Error("expected report, not error");
    if (report.source !== "jm-server") throw new Error("expected jm-server report");
    expect(report.host).toEqual({
      worktree_count: 3,
      terminal_count: 3,
      clean_count: 1,
      dirty_count: 2,
      dirty_path_count: 3,
      active_task_count: 2,
    });
    expect("github" in report).toBe(false);
  });

  it("keeps a JM-SERVER host report when one listed worktree is not a git checkout", async () => {
    // Given Orca lists a directory that git status cannot measure
    const git: CollectorCommandRunner = async (args) => {
      const path = args[1];
      if (path === "/repo/two") throw new Error("fatal: not a git repository");
      if (path === "/repo/one") return " M src/a.ts\n?? new.txt\n";
      if (path === "/repo/three") return " M b.ts\n";
      throw new Error(`unexpected git path ${String(path)}`);
    };
    const { input } = options({ source: "jm-server", gitRunner: git });

    // When the collector measures the host
    const envelope = await collectPortfolioEnvelope(input, KEY);
    const report = envelope.report;

    // Then one git failure does not collapse the signed report into COLLECTOR_FAILED
    if ("collector_status" in report) throw new Error("expected report, not error");
    if (report.source !== "jm-server") throw new Error("expected jm-server report");
    expect(report.host).toEqual({
      worktree_count: 3,
      terminal_count: 3,
      clean_count: 0,
      dirty_count: 3,
      dirty_path_count: 3,
      active_task_count: 2,
    });
  });

  it("signs a generic COLLECTOR_FAILED error envelope without leaking command output", async () => {
    const failing: CollectorCommandRunner = async () => {
      throw new Error("secret stdout: ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    };
    const { input } = options({ orcaRunner: failing });
    const envelope = await collectPortfolioEnvelope(input, KEY);
    expect(envelope.report).toEqual({
      schema_version: 1,
      source: "local",
      reported_at: PORTFOLIO_AT,
      collector_status: "error",
      collector_error: "COLLECTOR_FAILED",
    });
    expect(JSON.stringify(envelope)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    const payload = verifyPortfolioAuthenticatedEnvelope(Buffer.from(JSON.stringify(envelope), "utf8"), KEY, "local");
    expect(JSON.parse(payload.toString("utf8"))).toEqual(envelope.report);
  });

  it("rejects LOCAL collection without both manifests before running commands", async () => {
    await expect(main(["--source", "local", "--key-file", "/nonexistent.key"])).rejects.toThrow();
  });
});
