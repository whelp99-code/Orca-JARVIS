import { AuthorityDb, JarvisError } from "./db.js";
import { observationClock } from "./observation-health-store.js";

type ObservationRow = {
  canonical_path: string; provider: string; terminal_id: string; session_id: string; incarnation_id: string;
  state: string | null; error_code: string | null; consecutive_failures: number | null;
  last_attempt_at: string | null; last_finished_at: string | null; last_success_at: string | null; next_attempt_at: string | null;
};
export function readObservationHealth(db: AuthorityDb, now: Date) {
  observationClock(now);
  const rows = db.db.prepare(`SELECT b.canonical_path,b.provider,b.terminal_id,b.session_id,b.incarnation_id,
    h.state,h.error_code,h.consecutive_failures,h.last_attempt_at,h.last_finished_at,h.last_success_at,h.next_attempt_at
    FROM live_supervisor_bindings b LEFT JOIN live_observation_health h
    ON h.canonical_path=b.canonical_path AND h.provider=b.provider AND h.terminal_id=b.terminal_id
    AND h.session_id=b.session_id AND h.incarnation_id=b.incarnation_id AND h.pty_id IS b.pty_id AND h.worktree_id IS b.worktree_id
    ORDER BY b.canonical_path,b.provider,b.terminal_id`).all() as ObservationRow[];
  const bindings = rows.map(row => {
    const age = row.last_success_at === null ? NaN : now.getTime() - Date.parse(row.last_success_at);
    const state = row.state === "healthy" && (!Number.isFinite(age) || age < 0 || age >= 120_000) ? "stale" : row.state ?? "unobserved";
    return { ...row, state, consecutive_failures: row.consecutive_failures ?? 0 };
  });
  return { bindings, total: bindings.length, healthy: bindings.filter(row => row.state === "healthy").length,
    unavailable: bindings.filter(row => row.state === "unavailable").length,
    fatal: bindings.filter(row => row.state === "fatal").length,
    pending: bindings.filter(row => !["healthy", "unavailable", "fatal"].includes(row.state)).length };
}
/** A loop heartbeat is not evidence that coordinator execution recovered. */
export function recordRuntimeHeartbeat(db: AuthorityDb, now: string): void {
  db.db.prepare(`INSERT INTO gjc_runtime_status(id,pid,last_heartbeat_at,last_error_code,updated_at) VALUES(1,?,?,NULL,?)
    ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,last_heartbeat_at=excluded.last_heartbeat_at,updated_at=excluded.updated_at`)
    .run(process.pid, now, now);
}
export function recordCoordinatorAttempt(db: AuthorityDb, now: string): void {
  db.db.prepare("UPDATE gjc_runtime_status SET last_coordinator_attempt_at=? WHERE id=1").run(now);
}
export function withRuntimeHealthFence(db: AuthorityDb, owner: string, fence: number, now: string, action: () => void): void {
  db.db.transaction(() => {
    db.heartbeatGjcRuntimeLease(owner, fence, now);
    action();
  }).immediate();
}
export function recordCoordinatorOutcome(db: AuthorityDb, intent: string, state: string, now: string): void {
  if (state === "accepted" || state === "completed") {
    db.recordGjcRuntimeStatus(null, now);
    db.db.prepare("UPDATE gjc_runtime_status SET last_coordinator_success_at=? WHERE id=1").run(now);
  } else {
    const row = db.db.prepare("SELECT failure_code FROM gjc_intents WHERE intent_id=?").get(intent) as { failure_code: string | null };
    const code = row.failure_code && /^GJC_[A-Z0-9_]{1,64}$/u.test(row.failure_code) ? row.failure_code
      : state === "failed" ? "GJC_CYCLE_FAILED" : "GJC_CYCLE_UNCERTAIN";
    db.recordGjcRuntimeStatus(code, now);
  }
}

export function readServiceHealth(db: AuthorityDb, now: Date): Record<string, unknown> {
  const config = db.gjcConfig();
  const rows = db.db.prepare("SELECT state,COUNT(*) AS count FROM gjc_intents GROUP BY state ORDER BY state").all() as Array<{
    state: string;
    count: number;
  }>;
  const runtime = db.db.prepare(`SELECT pid,last_heartbeat_at,last_error_code,last_coordinator_attempt_at,
    last_coordinator_success_at FROM gjc_runtime_status WHERE id=1`).get() ?? null;
  const intents = Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
  const bindings = db.db.prepare("SELECT COUNT(*) AS count FROM live_supervisor_bindings")
    .get() as { count: number };
  return {
    connected: Boolean(config?.operational),
    config,
    runtime,
    observation_health: readObservationHealth(db, now),
    intents,
    work_readiness: {
      coordinator_configured: config !== null,
      coordinator_operational: Boolean(config?.operational),
      observation_bindings: bindings.count,
      pending_intents: intents.pending ?? 0,
      uncertain_intents: intents.uncertain ?? 0,
    },
  };
}

export function requireNoFatalObservations(db: AuthorityDb, now: Date): void {
  const blocked = readObservationHealth(db, now).bindings.find(row => row.state === "fatal"
    || row.state === "probing" && row.error_code !== null
      && !["ORCA_CLI_UNAVAILABLE", "ORCA_CLI_TIMEOUT", "ORCA_BINDING_NOT_OBSERVED"].includes(row.error_code));
  if (blocked) throw new JarvisError(blocked.error_code ?? "ORCA_OBSERVATION_FAILED");
}
