import { type AuthorityDb, JarvisError } from "./db.js";
import { requireObservationAttempt } from "./observation-health-store.js";
import { canonicalize } from "./canonical.js";
import type { ProgressState } from "./types.js";
import type { LiveObservationReader, LiveSupervisorCycle } from "./live-supervisor.js";
import { listLiveBindings } from "./live-supervisor-bindings.js";
import { liveSupervisorReport } from "./live-supervisor-reports.js";
import { digest, id, nonempty, liveSupervisorTransaction, type Row } from "./live-supervisor-shared.js";
const states = new Set<ProgressState>(["running", "needs_input", "approval_required", "verifying", "stopped", "unknown"]);
export async function cycleLiveObservations(
  authority: AuthorityDb,
  observe: LiveObservationReader,
  now = new Date().toISOString(),
): Promise<LiveSupervisorCycle> {
  const recovered = authority.db
    .prepare(
      `SELECT r.report_id, r.payload_json, r.payload_digest FROM live_supervisor_reports r LEFT JOIN
        live_supervisor_report_receipts d ON d.report_id=r.report_id WHERE d.report_id IS NULL ORDER BY r.created_at,
        r.report_id LIMIT 1`,
    )
    .get() as Row | undefined;
  if (recovered) return { report: null, authority_items: [], resume_candidates: [], recovered_report: liveSupervisorReport(recovered) };
  const bindings = listLiveBindings(authority).map(binding => Object.freeze({ ...binding }));
  if (bindings.length === 0) throw new JarvisError("LIVE_WORKTREE_UNREGISTERED");
  const settled = await Promise.allSettled(bindings.map(async binding => ({ binding, values: await observe(binding) })));
  const failure = settled.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  const observed = settled.flatMap(result => result.status === "fulfilled"
    ? result.value.values.map(value => ({ binding: result.value.binding, value })) : []);
  return liveSupervisorTransaction(authority, () => {
    const changes: Array<Record<string, unknown>> = [];
    const authority_items: string[] = [];
    const resume_candidates: string[] = [];
    const seen = new Set<string>();
    for (const { binding, value } of observed) {
      const observedAt = value.observation_attempt_id === undefined ? now
        : requireObservationAttempt(authority, binding, value.observation_attempt_id);
      const key = `${binding.canonical_path}\0${binding.provider}\0${binding.terminal_id}`;
      if (seen.has(key)) throw new JarvisError("LIVE_OBSERVATION_DUPLICATE");
      seen.add(key);
      if (
        value.provider !== binding.provider ||
        value.terminal_id !== binding.terminal_id ||
        value.session_id !== binding.session_id ||
        value.incarnation_id !== binding.incarnation_id ||
        !states.has(value.state) ||
        (value.cursor !== null && !nonempty(value.cursor))
      )
        throw new JarvisError("LIVE_OBSERVATION_INVALID");
      if (value.connected !== undefined && typeof value.connected !== "boolean") throw new JarvisError("LIVE_OBSERVATION_INVALID");
      const projection = authority.db
        .prepare(
          `SELECT state FROM progress_projection WHERE worktree_selector=? AND provider=? AND terminal_handle=? AND
            incarnation_id=?`,
        )
        .get(binding.canonical_path, binding.provider, binding.terminal_id, binding.incarnation_id) as Row | undefined;
      const state = projection ? (String(projection.state) as ProgressState) : value.state;
      const observation_digest = digest({
        worktree: binding.canonical_path,
        provider: value.provider,
        terminal_id: value.terminal_id,
        session_id: value.session_id,
        incarnation_id: value.incarnation_id,
        cursor: value.cursor,
        state,
        ...(value.connected === undefined ? {} : { connected: value.connected }),
      });
      const prior = authority.db
        .prepare(
          `SELECT next_cursor, session_id, incarnation_id, projection_state, observation_digest FROM live_supervisor_cursors
            WHERE canonical_path=? AND provider=? AND terminal_id=?`,
        )
        .get(binding.canonical_path, binding.provider, binding.terminal_id) as Row | undefined;
      if (
        !prior ||
        prior.next_cursor !== value.cursor ||
        prior.session_id !== value.session_id ||
        prior.incarnation_id !== value.incarnation_id ||
        prior.projection_state !== state ||
        prior.observation_digest !== observation_digest
      )
        changes.push({
          worktree: binding.canonical_path,
          provider: value.provider,
          terminal_id: value.terminal_id,
          session_id: value.session_id,
          incarnation_id: value.incarnation_id,
          cursor: value.cursor,
          state,
          ...(value.connected === undefined ? {} : { connected: value.connected }),
        });
      authority.db
        .prepare(
          `INSERT INTO live_supervisor_cursors(canonical_path, provider, terminal_id, session_id, incarnation_id,
            next_cursor, updated_at, projection_state, observation_digest) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON
            CONFLICT(canonical_path, provider, terminal_id) DO UPDATE SET session_id=excluded.session_id,
            incarnation_id=excluded.incarnation_id, next_cursor=excluded.next_cursor, updated_at=excluded.updated_at,
            projection_state=excluded.projection_state, observation_digest=excluded.observation_digest`,
        )
        .run(
          binding.canonical_path,
          value.provider,
          value.terminal_id,
          value.session_id,
          value.incarnation_id,
          value.cursor,
          observedAt,
          state,
          observation_digest,
        );
      authority.db
        .prepare(
          `UPDATE live_supervisor_cursors SET connected=?
            WHERE canonical_path=? AND provider=? AND terminal_id=?`,
        )
        .run(value.connected === undefined ? null : Number(value.connected), binding.canonical_path, value.provider, value.terminal_id);
    }
    const sourceRows = authority.db
      .prepare(
        `SELECT s.candidate_id, s.progress_report_id, s.pre_gjc_report_id FROM live_supervisor_candidate_report_sources s
          JOIN pre_gjc_candidates c ON c.candidate_id=s.candidate_id JOIN live_supervisor_bindings b ON
          b.canonical_path=c.worktree_selector AND b.provider=c.provider AND b.terminal_id=c.terminal_handle AND
          b.incarnation_id=c.incarnation_id LEFT JOIN live_supervisor_report_sources linked ON
          linked.candidate_id=s.candidate_id WHERE linked.candidate_id IS NULL ORDER BY s.candidate_id`,
      )
      .all() as Row[];
    const sources = sourceRows.map((source) => ({
      candidate_id: String(source.candidate_id),
      progress_report_id: typeof source.progress_report_id === "string" ? source.progress_report_id : null,
      pre_gjc_report_id: String(source.pre_gjc_report_id),
    }));
    const sorted = changes.sort((a, b) => canonicalize(a).localeCompare(canonicalize(b)));
    if (sorted.length === 0 && sources.length === 0)
      return {
        report: null,
        authority_items: [...new Set(authority_items)].sort(),
        resume_candidates: [...new Set(resume_candidates)].sort(),
        recovered_report: null,
      };
    // Include the preceding occurrence in the payload: both report ID and payload
    // digest are unique, even when an acknowledged connection state recurs.
    const previous = authority.db.prepare("SELECT report_id FROM live_supervisor_reports ORDER BY rowid DESC LIMIT 1").get() as
      Row | undefined;
    const payload = canonicalize({
      version: 3,
      previous_report_id: previous?.report_id ?? null,
      worktrees: [...new Set(bindings.map((binding) => binding.canonical_path))].sort(),
      changes: sorted,
      sources,
    });
    const payload_digest = digest(payload);
    const report_id = id("live_report", payload_digest);
    authority.db
      .prepare(
        `INSERT INTO live_supervisor_reports(report_id, canonical_path, payload_json, payload_digest, created_at)
          VALUES(?, ?, ?, ?, ?)`,
      )
      .run(report_id, "*", payload, payload_digest, now);
    for (const source of sources)
      authority.db
        .prepare(
          `INSERT INTO live_supervisor_report_sources(report_id, candidate_id, progress_report_id, pre_gjc_report_id)
            VALUES(?, ?, ?, ?)`,
        )
        .run(report_id, source.candidate_id, source.progress_report_id, source.pre_gjc_report_id);
    return {
      report: { report_id, payload_json: payload, payload_digest },
      authority_items: [...new Set(authority_items)].sort(),
      resume_candidates: [...new Set(resume_candidates)].sort(),
      recovered_report: null,
    };
  });
}
