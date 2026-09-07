import { randomUUID } from "node:crypto";
import { AuthorityDb, JarvisError } from "./db.js";
import type { LiveBinding } from "./live-supervisor.js";

const PROBE_LEASE_MS = 15_000;
export type ObservationHealth = {
  canonical_path: string; provider: string; terminal_id: string; session_id: string; incarnation_id: string;
  pty_id: string | null; worktree_id: string | null; attempt_id: string; cursor_before: string | null;
  state: "probing" | "healthy" | "unknown" | "unavailable" | "fatal";
  consecutive_failures: number; last_attempt_at: string; attempt_deadline: string;
  last_finished_at: string | null; last_success_at: string | null; next_attempt_at: string | null; error_code: string | null;
};
export function observationClock(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new JarvisError("LIVE_OBSERVATION_CLOCK_INVALID");
  return now.toISOString();
}
const key = (binding: LiveBinding) => [binding.canonical_path, binding.provider, binding.terminal_id];
function matches(row: Pick<ObservationHealth, "session_id" | "incarnation_id" | "pty_id" | "worktree_id">, binding: LiveBinding) {
  return row.session_id === binding.session_id && row.incarnation_id === binding.incarnation_id
    && row.pty_id === (binding.pty_id ?? null) && row.worktree_id === (binding.worktree_id ?? null);
}
function requireBinding(db: AuthorityDb, binding: LiveBinding): void {
  const row = db.db.prepare(`SELECT session_id,incarnation_id,pty_id,worktree_id FROM live_supervisor_bindings
    WHERE canonical_path=? AND provider=? AND terminal_id=?`).get(...key(binding)) as ObservationHealth | undefined;
  if (!row || !matches(row, binding)) throw new JarvisError("LIVE_OBSERVATION_BINDING_CHANGED");
}
function get(db: AuthorityDb, binding: LiveBinding): ObservationHealth | undefined {
  return db.db.prepare(`SELECT * FROM live_observation_health WHERE canonical_path=? AND provider=? AND terminal_id=?`)
    .get(...key(binding)) as ObservationHealth | undefined;
}
function requireCursor(db: AuthorityDb, binding: LiveBinding): void {
  const row = db.db.prepare(`SELECT next_cursor,session_id,incarnation_id FROM live_supervisor_cursors
    WHERE canonical_path=? AND provider=? AND terminal_id=?`).get(...key(binding)) as
    { next_cursor: string | null; session_id: string; incarnation_id: string } | undefined;
  if ((row?.next_cursor ?? null) !== binding.cursor || row
    && (row.session_id !== binding.session_id || row.incarnation_id !== binding.incarnation_id)) {
    throw new JarvisError("LIVE_OBSERVATION_CURSOR_STALE");
  }
}
export function beginObservation(db: AuthorityDb, binding: LiveBinding, now: Date): string | null {
  const at = observationClock(now);
  return db.db.transaction(() => {
    requireBinding(db, binding); requireCursor(db, binding);
    const stored = get(db, binding);
    const prior = stored && matches(stored, binding) ? stored : undefined;
    if (prior && (at < prior.last_attempt_at || at < (prior.last_finished_at ?? prior.last_attempt_at))) {
      throw new JarvisError("LIVE_OBSERVATION_CLOCK_REGRESSED");
    }
    if (prior?.state === "probing" && at < prior.attempt_deadline) {
      if (prior.error_code && prior.error_code !== "ORCA_CLI_UNAVAILABLE" && prior.error_code !== "ORCA_CLI_TIMEOUT"
        && prior.error_code !== "ORCA_BINDING_NOT_OBSERVED") throw new JarvisError(prior.error_code);
      return null;
    }
    if (prior?.state === "unavailable" && prior.next_attempt_at !== null && at < prior.next_attempt_at) return null;
    const token = randomUUID();
    db.db.prepare(`INSERT INTO live_observation_health(canonical_path,provider,terminal_id,session_id,incarnation_id,
      pty_id,worktree_id,attempt_id,cursor_before,state,consecutive_failures,last_attempt_at,attempt_deadline,
      last_finished_at,last_success_at,error_code)
      VALUES(?,?,?,?,?,?,?,?,?,'probing',?,?,?,?,?,?) ON CONFLICT(canonical_path,provider,terminal_id) DO UPDATE SET
      session_id=excluded.session_id,incarnation_id=excluded.incarnation_id,pty_id=excluded.pty_id,worktree_id=excluded.worktree_id,
      attempt_id=excluded.attempt_id,cursor_before=excluded.cursor_before,state='probing',consecutive_failures=excluded.consecutive_failures,
      last_attempt_at=excluded.last_attempt_at,attempt_deadline=excluded.attempt_deadline,last_finished_at=excluded.last_finished_at,
      last_success_at=excluded.last_success_at,error_code=excluded.error_code,next_attempt_at=NULL`)
      .run(...key(binding), binding.session_id, binding.incarnation_id, binding.pty_id ?? null, binding.worktree_id ?? null,
        token, binding.cursor, prior?.consecutive_failures ?? 0, at, new Date(now.getTime() + PROBE_LEASE_MS).toISOString(),
        prior?.last_finished_at ?? null, prior?.last_success_at ?? null, prior?.error_code ?? null);
    return token;
  }).immediate();
}
export function finishObservation(db: AuthorityDb, binding: LiveBinding, token: string, now: Date,
  state: Exclude<ObservationHealth["state"], "probing">, code: string | null): void {
  const at = observationClock(now);
  db.db.transaction(() => {
    requireBinding(db, binding); requireCursor(db, binding);
    const prior = get(db, binding);
    if (!prior || !matches(prior, binding) || prior.attempt_id !== token || prior.state !== "probing"
      || prior.cursor_before !== binding.cursor) {
      throw new JarvisError("LIVE_OBSERVATION_ATTEMPT_STALE");
    }
    if (at < prior.last_attempt_at) throw new JarvisError("LIVE_OBSERVATION_CLOCK_REGRESSED");
    if (at >= prior.attempt_deadline) throw new JarvisError("LIVE_OBSERVATION_ATTEMPT_EXPIRED");
    const failures = state === "unavailable" || state === "fatal" ? Math.min(31, prior.consecutive_failures + 1) : 0;
    const delay = Math.min(60_000, 10_000 * 2 ** (failures - 1));
    const next = state === "unavailable" ? new Date(now.getTime() + delay).toISOString() : null;
    db.db.prepare(`UPDATE live_observation_health SET state=?,consecutive_failures=?,last_finished_at=?,
      last_success_at=?,next_attempt_at=?,error_code=? WHERE canonical_path=? AND provider=? AND terminal_id=? AND attempt_id=?`)
      .run(state, failures, at, state === "healthy" ? at : prior.last_success_at, next, code, ...key(binding), token);
  }).immediate();
}
/** Call inside the cursor/report write transaction to reject superseded async results. */
export function requireObservationAttempt(db: AuthorityDb, binding: LiveBinding, token: string): string {
  requireBinding(db, binding);
  const row = get(db, binding);
  if (!row || !matches(row, binding) || row.attempt_id !== token || row.cursor_before !== binding.cursor || row.state === "probing"
    || row.state === "fatal" || row.last_finished_at === null) throw new JarvisError("LIVE_OBSERVATION_ATTEMPT_STALE");
  requireCursor(db, binding);
  return row.last_finished_at;
}
