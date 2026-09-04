import {
  MILESTONE_STATES,
  type PortfolioAuthEnvelopeV1,
  type PortfolioBlocker,
  type PortfolioEnvironment,
  type PortfolioHostCounts,
  type PortfolioMilestone,
  type PortfolioReportV1,
} from "./portfolio-contracts.js";
import { signPortfolioEnvelope } from "./portfolio-auth.js";

const COLLECTOR_FAILED = "COLLECTOR_FAILED" as const;
const GITHUB_TOTAL_MAX = 1_000_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type CollectorCommandRunner = (args: readonly string[]) => Promise<string>;
export type CollectorFileReader = (path: string) => Promise<string>;

export type PortfolioCollectorInput = {
  readonly source: PortfolioEnvironment;
  readonly scopeFile: string | null;
  readonly statusFile: string | null;
  readonly orcaRunner: CollectorCommandRunner;
  readonly ghRunner: CollectorCommandRunner;
  readonly gitRunner: CollectorCommandRunner;
  readonly readFile: CollectorFileReader;
  readonly clock: () => Date;
};

type WorktreeEntry = {
  readonly cwd: string;
  readonly workingCount: number;
};

type PortfolioGithubSummary = {
  readonly issue_count: number;
  readonly pull_request_count: number;
};

type PortfolioLocalSummary = {
  readonly github: PortfolioGithubSummary;
  readonly milestones: readonly PortfolioMilestone[];
  readonly blockers: readonly PortfolioBlocker[];
};

export async function collectPortfolioEnvelope(
  input: PortfolioCollectorInput,
  key: Buffer,
): Promise<PortfolioAuthEnvelopeV1> {
  const reportedAt = new Date(input.clock().getTime()).toISOString();
  try {
    const host = await collectHost(input);
    const report: PortfolioReportV1 =
      input.source === "local"
        ? { schema_version: 1, source: "local", reported_at: reportedAt, host, ...(await collectLocalSummary(input)) }
        : { schema_version: 1, source: "jm-server", reported_at: reportedAt, host };
    return signPortfolioEnvelope(report, key);
  } catch {
    // no-excuse-ok: catch — the collector boundary collapses every failure into
    // a generic signed error envelope; the bounded status never carries output.
    return signPortfolioEnvelope(
      {
        schema_version: 1,
        source: input.source,
        reported_at: reportedAt,
        collector_status: "error",
        collector_error: COLLECTOR_FAILED,
      },
      key,
    );
  }
}

async function collectHost(input: PortfolioCollectorInput): Promise<PortfolioHostCounts> {
  const [worktreeOutput, terminalOutput] = await Promise.all([
    input.orcaRunner(["worktree", "ps", "--json"]),
    input.orcaRunner(["terminal", "list", "--json"]),
  ]);
  const worktrees = parseWorktrees(worktreeOutput);
  const dirtyPaths = await Promise.all(
    worktrees.map(async (entry) => {
      try {
        const output = await input.gitRunner(["-C", entry.cwd, "status", "--porcelain=v1"]);
        return splitLines(output).length;
      } catch (error) {
        if (error instanceof Error) return null;
        throw error;
      }
    }),
  );
  const cleanCount = dirtyPaths.reduce<number>((total, count) => total + (count === 0 ? 1 : 0), 0);
  return {
    worktree_count: worktrees.length,
    terminal_count: parseTerminalCount(terminalOutput),
    clean_count: cleanCount,
    dirty_count: worktrees.length - cleanCount,
    dirty_path_count: dirtyPaths.reduce<number>((total, count) => total + (count ?? 0), 0),
    active_task_count: worktrees.reduce((total, entry) => total + entry.workingCount, 0),
  };
}

function parseWorktrees(output: string): readonly WorktreeEntry[] {
  const result = parseOrcaResult(output);
  const containers = Array.isArray(result.worktrees) ? result.worktrees : Array.isArray(result.items) ? result.items : fail();
  return containers.map((value) => {
    const container = asRecord(value);
    const cwd = container.cwd ?? container.worktreePath ?? container.path;
    if (typeof cwd !== "string" || !cwd.startsWith("/")) fail();
    if (!Array.isArray(container.agents)) fail();
    let workingCount = 0;
    for (const raw of container.agents) {
      const agent = asRecord(raw);
      if (agent.state === "working") workingCount += 1;
    }
    return { cwd, workingCount };
  });
}

function parseTerminalCount(output: string): number {
  const result = parseOrcaResult(output);
  if (!Array.isArray(result.terminals)) fail();
  return result.terminals.length;
}

async function collectLocalSummary(input: PortfolioCollectorInput): Promise<PortfolioLocalSummary> {
  if (input.scopeFile === null || input.statusFile === null) fail();
  const [scope, status] = await Promise.all([
    input.readFile(input.scopeFile),
    input.readFile(input.statusFile),
  ]);
  const repositories = parseRepositories(scope);
  const statusSummary = parseStatus(status);
  const githubOutput = await input.ghRunner(["api", "graphql", "-f", `query=${githubQuery(repositories)}`]);
  return { github: parseGithub(repositories, githubOutput), ...statusSummary };
}

function githubQuery(repositories: readonly string[]): string {
  const selections = repositories.map((repository, index) => {
    const [owner, name] = repository.split("/");
    if (owner === undefined || name === undefined) fail();
    return `r${index}: repository(owner: "${owner}", name: "${name}") { issues(states: OPEN) { totalCount } pullRequests(states: OPEN) { totalCount } }`;
  });
  return `query { ${selections.join(" ")} }`;
}

function parseRepositories(scope: string): readonly string[] {
  const manifest = JSON.parse(scope) as { readonly schema_version?: unknown; readonly repositories?: unknown };
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.repositories) || manifest.repositories.length === 0) fail();
  return manifest.repositories.map((repository) => {
    if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)) fail();
    return repository;
  });
}

function parseStatus(status: string): Omit<PortfolioLocalSummary, "github"> {
  const manifest = JSON.parse(status) as { readonly schema_version?: unknown; readonly milestones?: unknown; readonly blockers?: unknown };
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.milestones) || !Array.isArray(manifest.blockers)) fail();
  return {
    milestones: manifest.milestones.map((value): PortfolioMilestone => {
      const record = asRecord(value);
      const title = record.title;
      if (typeof title !== "string" || title.length === 0) fail();
      return { title, state: parseMilestoneState(record.state) };
    }),
    blockers: manifest.blockers.map((value): PortfolioBlocker => {
      const record = asRecord(value);
      const title = record.title;
      if (typeof title !== "string" || title.length === 0 || record.kind !== "approval_required") fail();
      return { title, kind: "approval_required" };
    }),
  };
}

function parseMilestoneState(value: unknown): PortfolioMilestone["state"] {
  for (const state of MILESTONE_STATES) {
    if (state === value) return state;
  }
  return fail();
}

function parseGithub(repositories: readonly string[], output: string): PortfolioGithubSummary {
  const payload = JSON.parse(output) as { readonly data?: unknown };
  const data = payload.data;
  if (!isRecord(data)) fail();
  let issueCount = 0;
  let pullRequestCount = 0;
  repositories.forEach((_repository, index) => {
    const node = data[`r${index}`];
    if (!isRecord(node)) fail();
    issueCount += parseTotal(asRecord(node.issues).totalCount);
    pullRequestCount += parseTotal(asRecord(node.pullRequests).totalCount);
  });
  return { issue_count: issueCount, pull_request_count: pullRequestCount };
}

function parseOrcaResult(output: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    fail();
  }
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.result)) fail();
  return payload.result;
}

function parseTotal(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > GITHUB_TOTAL_MAX) fail();
  return value;
}

function splitLines(output: string): readonly string[] {
  return output.split("\n").filter((line) => line.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  fail();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(): never {
  throw new Error(COLLECTOR_FAILED);
}
