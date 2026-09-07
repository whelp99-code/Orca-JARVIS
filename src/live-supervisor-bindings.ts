import { realpathSync } from "node:fs";
import { type AuthorityDb, JarvisError } from "./db.js";
import { decodeEnvWorktree, ORCA_ENV_PATH_PREFIX } from "./orca-env.js";
import type { OrcaProvider } from "./types.js";
import type { LiveBinding } from "./live-supervisor.js";
import { nonempty, liveSupervisorTransaction, type Row } from "./live-supervisor-shared.js";
export function liveWorktreePath(value: string): string {
  if (value.startsWith(ORCA_ENV_PATH_PREFIX)) {
    // Remote Orca hosts are not mounted locally; validate encoding only.
    try {
      decodeEnvWorktree(value);
      return value;
    } catch {
      throw new JarvisError("LIVE_WORKTREE_INVALID");
    }
  }
  try {
    const canonical = realpathSync(value);
    if (!canonical.startsWith("/")) throw new Error();
    return canonical;
  } catch {
    throw new JarvisError("LIVE_WORKTREE_INVALID");
  }
}

function liveBinding(input: Omit<LiveBinding, "canonical_path" | "cursor"> & { worktree: string }): LiveBinding {
  const canonical_path = liveWorktreePath(input.worktree);
  if (
    !(["codex", "claude"] as string[]).includes(input.provider) ||
    !nonempty(input.terminal_id) ||
    !nonempty(input.session_id) ||
    !nonempty(input.incarnation_id)
  )
    throw new JarvisError("LIVE_BINDING_INVALID");
  return {
    canonical_path,
    provider: input.provider,
    terminal_id: input.terminal_id,
    session_id: input.session_id,
    incarnation_id: input.incarnation_id,
    cursor: null,
    pty_id: input.pty_id,
    worktree_id: input.worktree_id,
    project_id: input.project_id,
  };
}

export function registerLiveBinding(
  authority: AuthorityDb,
  input: Omit<LiveBinding, "canonical_path" | "cursor"> & { worktree: string },
  now = new Date().toISOString(),
): LiveBinding {
  const binding = liveBinding(input);
  return liveSupervisorTransaction(authority, () => {
    authority.db
      .prepare("INSERT INTO live_supervisor_worktrees(canonical_path,created_at) VALUES(?,?) ON CONFLICT(canonical_path) DO NOTHING")
      .run(binding.canonical_path, now);
    const prior = authority.db
      .prepare(
        `SELECT session_id, incarnation_id, pty_id, worktree_id, project_id FROM live_supervisor_bindings WHERE
          canonical_path=? AND provider=? AND terminal_id=?`,
      )
      .get(binding.canonical_path, binding.provider, binding.terminal_id) as Row | undefined;
    if (
      prior &&
      (prior.session_id !== binding.session_id ||
        prior.incarnation_id !== binding.incarnation_id ||
        prior.pty_id !== (binding.pty_id ?? null) ||
        prior.worktree_id !== (binding.worktree_id ?? null) ||
        prior.project_id !== (binding.project_id ?? null))
    )
      throw new JarvisError("LIVE_BINDING_REBIND_REJECTED");
    authority.db
      .prepare(
        `INSERT INTO live_supervisor_bindings(canonical_path, provider, terminal_id, session_id, incarnation_id,
          created_at, pty_id, worktree_id, project_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(canonical_path,
          provider, terminal_id) DO NOTHING`,
      )
      .run(
        binding.canonical_path,
        binding.provider,
        binding.terminal_id,
        binding.session_id,
        binding.incarnation_id,
        now,
        binding.pty_id ?? null,
        binding.worktree_id ?? null,
        binding.project_id ?? null,
      );
    const cursor = authority.db
      .prepare("SELECT next_cursor FROM live_supervisor_cursors WHERE canonical_path=? AND provider=? AND terminal_id=?")
      .get(binding.canonical_path, binding.provider, binding.terminal_id) as Row | undefined;
    return { ...binding, cursor: cursor?.next_cursor === null || cursor?.next_cursor === undefined ? null : String(cursor.next_cursor) };
  });
}

export function listLiveBindings(authority: AuthorityDb): LiveBinding[] {
  return (
    authority.db
      .prepare(
        `SELECT b.canonical_path, b.provider, b.terminal_id, b.session_id, b.incarnation_id, b.pty_id, b.worktree_id,
          b.project_id, c.next_cursor FROM live_supervisor_bindings b LEFT JOIN live_supervisor_cursors c
          USING(canonical_path, provider, terminal_id) ORDER BY b.canonical_path, b.provider, b.terminal_id`,
      )
      .all() as Row[]
  ).map((row) => ({
    canonical_path: String(row.canonical_path),
    provider: String(row.provider) as OrcaProvider,
    terminal_id: String(row.terminal_id),
    session_id: String(row.session_id),
    incarnation_id: String(row.incarnation_id),
    cursor: row.next_cursor === null || row.next_cursor === undefined ? null : String(row.next_cursor),
    pty_id: typeof row.pty_id === "string" ? row.pty_id : undefined,
    worktree_id: typeof row.worktree_id === "string" ? row.worktree_id : undefined,
    project_id: typeof row.project_id === "string" ? row.project_id : undefined,
  }));
}
