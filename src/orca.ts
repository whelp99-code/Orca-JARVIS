import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { AuthorityDb, JarvisError } from "./db.js";
import { createOrcaRunner, encodeEnvWorktree, LOCAL_ORCA_ENVIRONMENT, parseOrcaEnvironments } from "./orca-env.js";
import type { OrcaObservationDelta, OrcaProvider } from "./types.js";

const execFile = promisify(execFileCallback);
const DEFAULT_MAX_PAGES = 3;
const MAX_MAX_PAGES = 10;
const MAX_LIMIT = 1_000;
export type OrcaRunner = (args: readonly string[]) => Promise<string>;
export interface OrcaTerminal { handle: string; tabId?: string; leafId?: string; ptyId: string; incarnationId: string; worktreeId: string | null; worktreePath: string | null; title: string | null; connected: boolean; writable: boolean; lastOutputAt: number | null; preview: unknown; }
export interface OrcaReadResult { handle: string; status: string; tail: string[]; truncated: boolean; limited: boolean; oldestCursor: string | null; nextCursor: string | null; latestCursor: string | null; returnedLineCount: number; }
export interface DiscoveredOrcaBinding { worktree: string; provider: OrcaProvider; terminal_id: string; session_id: string; incarnation_id: string; pty_id: string; worktree_id: string; project_id?: string; working: boolean; last_activity_at: number; }
export interface OrcaObserveOptions { worktree?: string; bindings?: Record<string, OrcaProvider>; limit?: number; maxPages?: number; runner?: OrcaRunner; }
export interface OrcaObservationSummary { worktree: string; classified: Array<Pick<OrcaTerminal, "handle" | "incarnationId" | "title" | "connected"> & { provider: OrcaProvider }>; unclassified: Array<Pick<OrcaTerminal, "handle" | "incarnationId" | "title" | "connected">>; inserted_deltas: number; replayed_deltas: number; cursors: Array<{ handle: string; incarnation_id: string; next_cursor: string | null; pages: number; reset: boolean; stopped_no_progress: boolean }>; }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nullableString = (value: unknown): string | null => value === null || value === undefined ? null : typeof value === "string" ? value : invalidSchema();
const nullableEpochMs = (value: unknown): number | null => value === null ? null : typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : invalidSchema();
const string = (value: unknown): string => typeof value === "string" && value.length > 0 ? value : invalidSchema();
const boolean = (value: unknown): boolean => typeof value === "boolean" ? value : invalidSchema();
const number = (value: unknown): number => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : invalidSchema();
function invalidSchema(): never { throw new JarvisError("ORCA_CLI_SCHEMA_INVALID"); }
function identity(worktree: string, terminalHandle: string, incarnationId: string, cursorBefore: string | null): string { return `orca_${createHash("sha256").update(JSON.stringify([worktree, terminalHandle, incarnationId, cursorBefore])).digest("hex")}`; }

export const defaultRunner: OrcaRunner = async args => {
  try { return (await execFile("orca", [...args], { encoding: "utf8", maxBuffer: 1_000_000, windowsHide: true })).stdout; }
  catch { throw new JarvisError("ORCA_CLI_FAILED"); }
};

function parsePayload(text: string): Record<string, unknown> {
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new JarvisError("ORCA_CLI_JSON_INVALID"); }
  if (!isRecord(payload)) throw new JarvisError("ORCA_CLI_SCHEMA_INVALID");
  if (payload.ok !== true) throw new JarvisError("ORCA_CLI_FAILED");
  if (("version" in payload && payload.version !== 1) || !isRecord(payload.result)) throw new JarvisError("ORCA_CLI_SCHEMA_INVALID");
  return payload.result;
}

export class OrcaReadonlyAdapter {
  constructor(private readonly runner: OrcaRunner = defaultRunner) {}
  private async call(args: string[]): Promise<Record<string, unknown>> {
    let output: string;
    try { output = await this.runner(args); } catch (error) { if (error instanceof JarvisError) throw error; throw new JarvisError("ORCA_CLI_FAILED"); }
    return parsePayload(output);
  }
  async list(worktree: string): Promise<OrcaTerminal[]> {
    if (!worktree) throw new JarvisError("ORCA_WORKTREE_INVALID");
    const result = await this.call(["terminal", "list", "--worktree", worktree, "--json"]); const terminals = result.terminals;
    if (!Array.isArray(terminals)) return invalidSchema();
    return terminals.map(value => {
      if (!isRecord(value)) return invalidSchema();
      const worktreeId = nullableString(value.worktreeId); const worktreePath = nullableString(value.worktreePath ?? value.path);
      if (worktreeId === null && worktreePath === null || !("title" in value) || !("lastOutputAt" in value) || !("preview" in value) || (value.preview !== null && typeof value.preview !== "string")) return invalidSchema();
      const tabId = value.tabId === undefined ? undefined : string(value.tabId); const leafId = value.leafId === undefined ? undefined : string(value.leafId); return { handle: string(value.handle), tabId, leafId, ptyId: string(value.ptyId), incarnationId: string(value.incarnationId), worktreeId, worktreePath, title: nullableString(value.title), connected: boolean(value.connected), writable: boolean(value.writable), lastOutputAt: nullableEpochMs(value.lastOutputAt), preview: value.preview };
    });
  }
  async worktreePs(): Promise<Record<string, unknown>> { return this.call(["worktree", "ps", "--json"]); }
  async read(terminalHandle: string, cursor: string | null, limit: number): Promise<OrcaReadResult> {
    if (!terminalHandle || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new JarvisError("ORCA_READ_ARGUMENT_INVALID");
    const args = ["terminal", "read", "--terminal", terminalHandle]; if (cursor !== null) args.push("--cursor", cursor); args.push("--limit", String(limit), "--json");
    const result = await this.call(args); const terminal = result.terminal;
    if (!isRecord(terminal) || !Array.isArray(terminal.tail) || !terminal.tail.every(line => typeof line === "string")) return invalidSchema();
    const returnedLineCount = number(terminal.returnedLineCount); if (terminal.tail.length > limit || returnedLineCount !== terminal.tail.length) return invalidSchema();
    return { handle: string(terminal.handle), status: string(terminal.status), tail: terminal.tail, truncated: boolean(terminal.truncated), limited: boolean(terminal.limited), oldestCursor: nullableString(terminal.oldestCursor), nextCursor: nullableString(terminal.nextCursor), latestCursor: nullableString(terminal.latestCursor), returnedLineCount };
  }
}

export interface DiscoverOrcaOptions {
  runner?: OrcaRunner;
  /** Single Orca environment name (`local` or a saved remote such as `jm-server`). */
  environment?: string;
  /** Discover across multiple environments (default: ORCA_JARVIS_ENVIRONMENTS). */
  environments?: string[];
  maxBindings?: number;
  /** When true, a remote environment failure is skipped instead of aborting discovery. */
  tolerateRemoteFailure?: boolean;
}

/**
 * Finds bindings only from structured worktree/agent metadata and structured
 * terminal fields.  paneKey is a protocol identity, never a title or preview.
 * Remote Orca hosts use encoded worktree paths (`/orca-env/<env>/...`).
 */
export async function discoverOrcaBindings(runnerOrOptions?: OrcaRunner | DiscoverOrcaOptions, maybeOptions?: DiscoverOrcaOptions): Promise<DiscoveredOrcaBinding[]> {
  const options: DiscoverOrcaOptions = typeof runnerOrOptions === "function"
    ? { ...(maybeOptions ?? {}), runner: runnerOrOptions }
    : (runnerOrOptions ?? {});
  const environments = options.environments ?? (options.environment ? [options.environment] : options.runner ? [LOCAL_ORCA_ENVIRONMENT] : parseOrcaEnvironments());
  const maxBindings = options.maxBindings ?? Math.min(10, Math.max(5, environments.length * 5));
  const tolerateRemoteFailure = options.tolerateRemoteFailure ?? true;
  const collected: DiscoveredOrcaBinding[] = [];
  for (const environment of environments) {
    if (collected.length >= maxBindings) break;
    const runner = options.runner && environments.length === 1
      ? options.runner
      : createOrcaRunner(environment, options.runner ?? defaultRunner);
    try {
      const found = await discoverOrcaBindingsInEnvironment(runner, environment, maxBindings - collected.length);
      collected.push(...found);
    } catch (error) {
      if (environment === LOCAL_ORCA_ENVIRONMENT || !tolerateRemoteFailure) throw error;
      // Remote hosts may be offline; local discovery must still succeed.
    }
  }
  const identities = new Set<string>();
  for (const binding of collected) {
    const key = `${binding.worktree}\0${binding.terminal_id}`;
    if (identities.has(key)) throw new JarvisError("ORCA_PANE_BINDING_AMBIGUOUS");
    identities.add(key);
  }
  return collected;
}

async function discoverOrcaBindingsInEnvironment(runner: OrcaRunner, environment: string, maxBindings: number): Promise<DiscoveredOrcaBinding[]> {
  const adapter = new OrcaReadonlyAdapter(runner); const result = await adapter.worktreePs();
  const containers = Array.isArray(result.worktrees) ? result.worktrees : Array.isArray(result.items) ? result.items : invalidSchema();
  const candidates: Array<{ raw: Record<string, unknown>; worktree: string; listSelector: string; working: boolean; last_activity_at: number }> = [];
  for (const value of containers) {
    if (!isRecord(value)) return invalidSchema(); const cwdValue = value.cwd ?? value.worktreePath ?? value.path;
    if (typeof cwdValue !== "string" || !cwdValue || !cwdValue.startsWith("/")) return invalidSchema();
    const worktree = encodeEnvWorktree(environment, cwdValue);
    const listSelector = environment === LOCAL_ORCA_ENVIRONMENT ? worktree : `path:${cwdValue.replace(/\/+$/u, "") || "/"}`;
    const agents = value.agents; if (!Array.isArray(agents)) return invalidSchema();
    for (const agent of agents) { if (!isRecord(agent)) return invalidSchema(); const agentType = agent.agentType; if (agentType !== "codex" && agentType !== "claude") continue; const paneKey = string(agent.paneKey); const hasTab = agent.tabId !== undefined; const hasLeaf = agent.leafId !== undefined; if (hasTab !== hasLeaf) throw new JarvisError("ORCA_PANE_BINDING_INVALID"); if (hasTab && paneKey !== `${string(agent.tabId)}:${string(agent.leafId)}`) throw new JarvisError("ORCA_PANE_BINDING_INVALID"); const last = agent.updatedAt ?? agent.stateStartedAt; if (typeof last !== "number" || !Number.isFinite(last) || !Number.isInteger(last) || last < 0) return invalidSchema(); candidates.push({ raw: agent, worktree, listSelector, working: agent.state === "working", last_activity_at: last }); }
  }
  candidates.sort((a, b) => Number(b.working) - Number(a.working) || b.last_activity_at - a.last_activity_at || a.worktree.localeCompare(b.worktree) || string(a.raw.paneKey).localeCompare(string(b.raw.paneKey)));
  const byWorktree = new Map<string, OrcaTerminal[]>(); const failedWorktrees = new Set<string>();
  const bindings: DiscoveredOrcaBinding[] = [];
  for (const item of candidates) {
    const agentType = item.raw.agentType as OrcaProvider; const paneKey = string(item.raw.paneKey); if (!byWorktree.has(item.worktree) && !failedWorktrees.has(item.worktree)) { try { byWorktree.set(item.worktree, await adapter.list(item.listSelector)); } catch (error) { failedWorktrees.add(item.worktree); if (item.working) throw error; continue; } } if (failedWorktrees.has(item.worktree)) { if (item.working) throw new JarvisError("ORCA_PANE_BINDING_UNMATCHED"); continue; } const terminals = byWorktree.get(item.worktree) ?? []; if (terminals.some(terminal => (terminal.tabId === undefined) !== (terminal.leafId === undefined))) throw new JarvisError("ORCA_PANE_BINDING_INVALID"); const matches = terminals.filter(terminal => terminal.tabId !== undefined && terminal.leafId !== undefined && `${terminal.tabId}:${terminal.leafId}` === paneKey);
    if (matches.length > 1) throw new JarvisError("ORCA_PANE_BINDING_AMBIGUOUS"); if (matches.length === 0) { if (item.working) throw new JarvisError("ORCA_PANE_BINDING_UNMATCHED"); continue; } const terminal = matches[0]!;
    if (!terminal.worktreeId || !terminal.ptyId) throw new JarvisError("ORCA_PANE_BINDING_INVALID"); const session = item.raw.sessionId ?? item.raw.session_id;
    if (session !== undefined && (typeof session !== "string" || !session)) return invalidSchema();
    // Some Orca payloads expose no structured session id; incarnationId is the
    // sole logical session identity in that case and remains separately bound.
    bindings.push({ worktree: item.worktree, provider: agentType, terminal_id: terminal.handle, session_id: typeof session === "string" ? session : terminal.incarnationId, incarnation_id: terminal.incarnationId, pty_id: terminal.ptyId, worktree_id: terminal.worktreeId, project_id: typeof item.raw.projectId === "string" ? item.raw.projectId : undefined, working: item.working, last_activity_at: item.last_activity_at }); if (bindings.length >= maxBindings) break;
  }
  // Remote hosts may expose connected terminals without structured agent panes.
  // Fall back to terminal list so dual-host supervision still observes acloud PTYs.
  if (environment !== LOCAL_ORCA_ENVIRONMENT && bindings.length < maxBindings) {
    const bound = new Set(bindings.map(item => item.terminal_id));
    const seenWorktrees = new Set(candidates.map(item => item.listSelector));
    if (seenWorktrees.size === 0) {
      for (const value of containers) {
        if (!isRecord(value)) continue;
        const cwdValue = value.cwd ?? value.worktreePath ?? value.path;
        if (typeof cwdValue === "string" && cwdValue.startsWith("/")) seenWorktrees.add(`path:${cwdValue.replace(/\/+$/u, "") || "/"}`);
      }
    }
    for (const listSelector of [...seenWorktrees].sort()) {
      if (bindings.length >= maxBindings) break;
      let terminals: OrcaTerminal[];
      try { terminals = await adapter.list(listSelector); } catch { continue; }
      for (const terminal of terminals) {
        if (bindings.length >= maxBindings) break;
        if (bound.has(terminal.handle) || !terminal.connected || !terminal.worktreeId || !terminal.ptyId) continue;
        const provider = classifyOrcaTerminal(terminal) ?? "claude";
        const remotePath = listSelector.startsWith("path:") ? listSelector.slice("path:".length) : listSelector;
        const worktree = encodeEnvWorktree(environment, remotePath);
        bindings.push({
          worktree,
          provider,
          terminal_id: terminal.handle,
          session_id: terminal.incarnationId,
          incarnation_id: terminal.incarnationId,
          pty_id: terminal.ptyId,
          worktree_id: terminal.worktreeId,
          working: true,
          last_activity_at: terminal.lastOutputAt ?? 0,
        });
        bound.add(terminal.handle);
      }
    }
  }
  return bindings;
}

export function classifyOrcaTerminal(terminal: OrcaTerminal, bindings: Record<string, OrcaProvider> = {}): OrcaProvider | undefined {
  const bound = bindings[terminal.handle]; if (bound === "codex" || bound === "claude") return bound;
  if (!terminal.title) return undefined;
  const title = terminal.title.toLocaleLowerCase(); const codex = /\bcodex\b/i.test(title); const claude = /\bclaude(?:\s+code)?\b/i.test(title);
  return codex === claude ? undefined : codex ? "codex" : "claude";
}

export function parseOrcaBindings(value: unknown): Record<string, OrcaProvider> {
  if (!isRecord(value)) throw new JarvisError("ORCA_BINDINGS_INVALID");
  const bindings: Record<string, OrcaProvider> = {};
  for (const [handle, provider] of Object.entries(value)) { if (!handle || (provider !== "codex" && provider !== "claude")) throw new JarvisError("ORCA_BINDINGS_INVALID"); bindings[handle] = provider; }
  return bindings;
}

export async function observeOrca(db: AuthorityDb, options: OrcaObserveOptions = {}): Promise<OrcaObservationSummary> {
  const worktree = options.worktree ?? "active"; const limit = options.limit ?? 200; const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_MAX_PAGES) throw new JarvisError("ORCA_OBSERVE_ARGUMENT_INVALID");
  const adapter = new OrcaReadonlyAdapter(options.runner); const terminals = await adapter.list(worktree); const classified: OrcaObservationSummary["classified"] = []; const unclassified: OrcaObservationSummary["unclassified"] = []; const cursors: OrcaObservationSummary["cursors"] = [];
  let inserted = 0; let replayed = 0;
  for (const terminal of terminals) {
    const provider = classifyOrcaTerminal(terminal, options.bindings); const prior = provider ? db.getOrcaObservationSource(worktree, terminal.handle) : undefined; if (prior && prior.incarnation_id === terminal.incarnationId && prior.provider !== provider) throw new JarvisError("ORCA_SOURCE_BINDING_CONFLICT"); const descriptor = { handle: terminal.handle, incarnationId: terminal.incarnationId, title: terminal.title, connected: terminal.connected };
    if (!provider) { unclassified.push(descriptor); continue; }
    classified.push({ ...descriptor, provider }); if (!terminal.connected) continue;
    const reset = Boolean(prior && prior.incarnation_id !== terminal.incarnationId); let cursor = prior && !reset ? prior.next_cursor : null; const deltas: OrcaObservationDelta[] = []; let pages = 0; let stoppedNoProgress = false; const seen = new Set<string>();
    while (pages < maxPages) {
      const before = cursor; if (before !== null) seen.add(before); const read = await adapter.read(terminal.handle, before, limit); if (read.handle !== terminal.handle) throw new JarvisError("ORCA_CLI_SCHEMA_INVALID");
      deltas.push({ identity: identity(worktree, terminal.handle, terminal.incarnationId, before), worktree, terminal_handle: terminal.handle, provider, incarnation_id: terminal.incarnationId, cursor_before: before, cursor_after: read.nextCursor, tail: read.tail, truncated: read.truncated, limited: read.limited, oldest_cursor: read.oldestCursor, latest_cursor: read.latestCursor, returned_line_count: read.returnedLineCount, observed_at: new Date().toISOString() });
      pages++; cursor = read.nextCursor;
      if (!read.limited) break;
      if (cursor === null || cursor === before || seen.has(cursor)) { stoppedNoProgress = true; break; }
      seen.add(cursor);
    }
    const stored = db.recordOrcaObservations({ worktree, terminal_handle: terminal.handle, provider, incarnation_id: terminal.incarnationId, next_cursor: cursor }, deltas); inserted += stored.inserted; replayed += stored.replayed; cursors.push({ handle: terminal.handle, incarnation_id: terminal.incarnationId, next_cursor: cursor, pages, reset, stopped_no_progress: stoppedNoProgress });
  }
  return { worktree, classified, unclassified, inserted_deltas: inserted, replayed_deltas: replayed, cursors };
}
