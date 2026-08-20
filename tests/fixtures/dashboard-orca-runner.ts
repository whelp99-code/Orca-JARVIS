import type { OrcaRunner } from "../../src/orca.js";
import { FIXTURE_SECRET } from "./dashboard-fixture-ids.js";

const SAFE_LINE = "safe compile finished in 12.4s";
const SECRET_LINE = `export OPENAI_API_KEY=${FIXTURE_SECRET}`;

export const FIXTURE_LOG_LINES = [SAFE_LINE, SECRET_LINE] as const;

function envelope(result: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, result });
}

export function fixtureOrcaTerminal(worktreePath: string): Record<string, unknown> {
  return {
    handle: "term-e2e-1",
    tabId: "tab-e2e",
    leafId: "leaf-e2e",
    ptyId: "pty-e2e-1",
    incarnationId: "inc-e2e-1",
    worktreeId: "worktree-e2e-1",
    worktreePath,
    title: "Codex session",
    connected: true,
    writable: true,
    lastOutputAt: 1_723_215_678_901,
    preview: null,
  };
}

export function createFixtureOrcaRunner(worktreePath: string): OrcaRunner {
  const terminal = fixtureOrcaTerminal(worktreePath);
  return async (args) => {
    if (args[0] === "terminal" && args[1] === "send") throw new Error("terminal send is forbidden");
    if (args[1] === "list") return envelope({ terminals: [terminal] });
    if (args[1] === "read") {
      return envelope({
        terminal: {
          handle: terminal.handle,
          status: "running",
          tail: [...FIXTURE_LOG_LINES],
          truncated: false,
          limited: false,
          oldestCursor: null,
          nextCursor: "cursor-e2e-1",
          latestCursor: "cursor-e2e-1",
          returnedLineCount: FIXTURE_LOG_LINES.length,
        },
      });
    }
    throw new Error("unexpected orca invocation");
  };
}
