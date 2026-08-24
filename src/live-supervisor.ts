import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { canonicalize } from "./canonical.js";
import { AuthorityDb, JarvisError } from "./db.js";
export { RemoteDispatch } from "./remote-dispatch.js";
import { decodeEnvWorktree, ORCA_ENV_PATH_PREFIX } from "./orca-env.js";
import { PreGjcShadow } from "./pre-gjc-shadow.js";
import type { OrcaProvider, ProgressState } from "./types.js";

type Row = Record<string, unknown>;
const states = new Set<ProgressState>(["running", "needs_input", "approval_required", "verifying", "stopped", "unknown"]);
const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
const id = (prefix: string, value: unknown) => `${prefix}_${digest(value).slice(7)}`;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const resumePromptDigest = (binding: LiveBinding) => digest({ provider: binding.provider, terminal_id: binding.terminal_id, session_id: binding.session_id, incarnation_id: binding.incarnation_id, pty_id: binding.pty_id, worktree_id: binding.worktree_id, prompt: "Resume only the already-authorized bounded work. Do not widen scope or perform external actions." });

export interface LiveBinding { canonical_path: string; provider: OrcaProvider; terminal_id: string; session_id: string; incarnation_id: string; cursor: string | null; pty_id?: string; worktree_id?: string; project_id?: string; }
export interface LiveObservation { provider: OrcaProvider; terminal_id: string; session_id: string; incarnation_id: string; cursor: string | null; state: ProgressState; safe_reversible_in_scope?: boolean; unsafe?: boolean; }
export type LiveObservationReader = (binding: LiveBinding) => readonly LiveObservation[] | Promise<readonly LiveObservation[]>;
export interface LiveSupervisorCycle { report: { report_id: string; payload_json: string; payload_digest: string } | null; authority_items: string[]; resume_candidates: string[]; recovered_report: { report_id: string; payload_json: string; payload_digest: string } | null; }

/** Durable, local-only supervisor. It observes through an injected adapter and never sends or mutates terminals. */
export class LiveSupervisor {
  constructor(private readonly authority: AuthorityDb) {}
  private tx<T>(fn: () => T): T { this.authority.db.exec("BEGIN IMMEDIATE"); try { const value = fn(); this.authority.db.exec("COMMIT"); return value; } catch (error) { this.authority.db.exec("ROLLBACK"); throw error; } }
  private path(value: string): string {
    if (value.startsWith(ORCA_ENV_PATH_PREFIX)) {
      // Remote Orca hosts are not mounted locally; validate encoding only.
      try { decodeEnvWorktree(value); return value; } catch { throw new JarvisError("LIVE_WORKTREE_INVALID"); }
    }
    try { const canonical = realpathSync(value); if (!canonical.startsWith("/")) throw new Error(); return canonical; } catch { throw new JarvisError("LIVE_WORKTREE_INVALID"); }
  }
  private binding(input: Omit<LiveBinding, "canonical_path" | "cursor"> & { worktree: string }): LiveBinding {
    const canonical_path = this.path(input.worktree);
    if (!(["codex", "claude"] as string[]).includes(input.provider) || !nonempty(input.terminal_id) || !nonempty(input.session_id) || !nonempty(input.incarnation_id)) throw new JarvisError("LIVE_BINDING_INVALID");
    return { canonical_path, provider: input.provider, terminal_id: input.terminal_id, session_id: input.session_id, incarnation_id: input.incarnation_id, cursor: null, pty_id: input.pty_id, worktree_id: input.worktree_id, project_id: input.project_id };
  }
  register(input: Omit<LiveBinding, "canonical_path" | "cursor"> & { worktree: string }, now = new Date().toISOString()): LiveBinding {
    const binding = this.binding(input);
    return this.tx(() => {
      this.authority.db.prepare("INSERT INTO live_supervisor_worktrees(canonical_path,created_at) VALUES(?,?) ON CONFLICT(canonical_path) DO NOTHING").run(binding.canonical_path, now);
      const prior = this.authority.db.prepare("SELECT session_id,incarnation_id,pty_id,worktree_id,project_id FROM live_supervisor_bindings WHERE canonical_path=? AND provider=? AND terminal_id=?").get(binding.canonical_path, binding.provider, binding.terminal_id) as Row | undefined;
      if (prior && (prior.session_id !== binding.session_id || prior.incarnation_id !== binding.incarnation_id || prior.pty_id !== (binding.pty_id ?? null) || prior.worktree_id !== (binding.worktree_id ?? null) || prior.project_id !== (binding.project_id ?? null))) throw new JarvisError("LIVE_BINDING_REBIND_REJECTED");
      this.authority.db.prepare("INSERT INTO live_supervisor_bindings(canonical_path,provider,terminal_id,session_id,incarnation_id,created_at,pty_id,worktree_id,project_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(canonical_path,provider,terminal_id) DO NOTHING").run(binding.canonical_path, binding.provider, binding.terminal_id, binding.session_id, binding.incarnation_id, now, binding.pty_id ?? null, binding.worktree_id ?? null, binding.project_id ?? null);
      const cursor = this.authority.db.prepare("SELECT next_cursor FROM live_supervisor_cursors WHERE canonical_path=? AND provider=? AND terminal_id=?").get(binding.canonical_path, binding.provider, binding.terminal_id) as Row | undefined;
      return { ...binding, cursor: cursor?.next_cursor === null || cursor?.next_cursor === undefined ? null : String(cursor.next_cursor) };
    });
  }
  list(): LiveBinding[] { return (this.authority.db.prepare("SELECT b.canonical_path,b.provider,b.terminal_id,b.session_id,b.incarnation_id,b.pty_id,b.worktree_id,b.project_id,c.next_cursor FROM live_supervisor_bindings b LEFT JOIN live_supervisor_cursors c USING(canonical_path,provider,terminal_id) ORDER BY b.canonical_path,b.provider,b.terminal_id").all() as Row[]).map(row => ({ canonical_path: String(row.canonical_path), provider: String(row.provider) as OrcaProvider, terminal_id: String(row.terminal_id), session_id: String(row.session_id), incarnation_id: String(row.incarnation_id), cursor: row.next_cursor === null || row.next_cursor === undefined ? null : String(row.next_cursor), pty_id: typeof row.pty_id === "string" ? row.pty_id : undefined, worktree_id: typeof row.worktree_id === "string" ? row.worktree_id : undefined, project_id: typeof row.project_id === "string" ? row.project_id : undefined })); }
  private report(row: Row): { report_id: string; payload_json: string; payload_digest: string } { return { report_id: String(row.report_id), payload_json: String(row.payload_json), payload_digest: String(row.payload_digest) }; }
  acknowledgeReport(report_id: string, delivered_at = new Date().toISOString()): void {
    if (!/^live_report_[0-9a-f]{64}$/.test(report_id)) throw new JarvisError("LIVE_REPORT_INVALID");
    this.tx(() => {
      if (!this.authority.db.prepare("SELECT 1 FROM live_supervisor_reports WHERE report_id=?").get(report_id)) throw new JarvisError("LIVE_REPORT_INVALID");
      this.authority.db.prepare("INSERT INTO live_supervisor_report_receipts(report_id,delivered_at) VALUES(?,?) ON CONFLICT(report_id) DO NOTHING").run(report_id, delivered_at);
      const sources = this.authority.db.prepare("SELECT progress_report_id,pre_gjc_report_id FROM live_supervisor_report_sources WHERE report_id=? ORDER BY candidate_id").all(report_id) as Row[];
      for (const source of sources) {
        if (typeof source.progress_report_id === "string") this.authority.db.prepare("INSERT INTO progress_delivery_receipts(report_id,delivered_at) VALUES(?,?) ON CONFLICT(report_id) DO NOTHING").run(source.progress_report_id, delivered_at);
        const receipt = canonicalize({ live_report_id: report_id, delivered_at });
        this.authority.db.prepare("UPDATE pre_gjc_report_outbox SET state='delivered',delivered_at=COALESCE(delivered_at,?),receipt_json=COALESCE(receipt_json,?),lease_owner=NULL,lease_expires_at=NULL WHERE report_id=? AND state IN ('pending','leased','delivered')").run(delivered_at, receipt, source.pre_gjc_report_id);
      }
    });
  }
  async cycle(worktree: string, observe: LiveObservationReader, now = new Date().toISOString()): Promise<LiveSupervisorCycle> {
    this.path(worktree);
    return this.cycleAll(observe, now);
  }
  status(): Record<string, unknown> { const count = (table: string) => Number((this.authority.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Row).count); return { worktrees: count("live_supervisor_worktrees"), bindings: count("live_supervisor_bindings"), reports_pending: Number((this.authority.db.prepare("SELECT COUNT(*) AS count FROM live_supervisor_reports r LEFT JOIN live_supervisor_report_receipts d ON d.report_id=r.report_id WHERE d.report_id IS NULL").get() as Row).count), reports_delivered: Number((this.authority.db.prepare("SELECT COUNT(*) AS count FROM live_supervisor_report_receipts").get() as Row).count) }; }
  configureLiveResume(projectId: string, enabled: boolean, now = new Date()): void {
    const bindings = this.authority.db.prepare("SELECT canonical_path,provider,terminal_id,session_id,incarnation_id,pty_id,worktree_id FROM live_supervisor_bindings WHERE project_id=? AND pty_id IS NOT NULL AND worktree_id IS NOT NULL ORDER BY canonical_path,provider,terminal_id").all(projectId) as Row[];
    if (bindings.length !== 1) throw new JarvisError("LIVE_RESUME_CONFIG_INVALID");
    const binding = bindings[0]!; const configured_at = now.toISOString();
    const config_digest = digest({ project_id: projectId, enabled, canonical_path: binding.canonical_path, provider: binding.provider, terminal_id: binding.terminal_id, session_id: binding.session_id, incarnation_id: binding.incarnation_id, pty_id: binding.pty_id, worktree_id: binding.worktree_id });
    this.tx(() => {
      const inserted = this.authority.db.prepare("INSERT INTO live_supervisor_live_resume_config_audit(project_id,enabled,config_digest,created_at,canonical_path,provider,terminal_id,session_id,incarnation_id,pty_id,worktree_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(projectId, enabled ? 1 : 0, config_digest, configured_at, binding.canonical_path, binding.provider, binding.terminal_id, binding.session_id, binding.incarnation_id, binding.pty_id, binding.worktree_id);
      const revision = Number(inserted.lastInsertRowid);
      this.authority.db.prepare("INSERT INTO live_supervisor_live_resume_config(project_id,enabled,configured_at,revision,config_digest,canonical_path,provider,terminal_id,session_id,incarnation_id,pty_id,worktree_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled,configured_at=excluded.configured_at,revision=excluded.revision,config_digest=excluded.config_digest,canonical_path=excluded.canonical_path,provider=excluded.provider,terminal_id=excluded.terminal_id,session_id=excluded.session_id,incarnation_id=excluded.incarnation_id,pty_id=excluded.pty_id,worktree_id=excluded.worktree_id").run(projectId, enabled ? 1 : 0, configured_at, revision, config_digest, binding.canonical_path, binding.provider, binding.terminal_id, binding.session_id, binding.incarnation_id, binding.pty_id, binding.worktree_id);
    });
  }
  liveResumeConfigured(): boolean { return Boolean(this.authority.db.prepare("SELECT 1 FROM live_supervisor_live_resume_config c JOIN live_supervisor_live_resume_config_audit a ON a.revision=c.revision AND a.project_id=c.project_id AND a.enabled=c.enabled AND a.config_digest=c.config_digest AND a.canonical_path=c.canonical_path AND a.provider=c.provider AND a.terminal_id=c.terminal_id AND a.session_id=c.session_id AND a.incarnation_id=c.incarnation_id AND a.pty_id=c.pty_id AND a.worktree_id=c.worktree_id JOIN live_supervisor_bindings b ON b.project_id=c.project_id AND b.canonical_path=c.canonical_path AND b.provider=c.provider AND b.terminal_id=c.terminal_id AND b.session_id=c.session_id AND b.incarnation_id=c.incarnation_id AND b.pty_id=c.pty_id AND b.worktree_id=c.worktree_id WHERE c.enabled=1 LIMIT 1").get()); }
  pendingLiveResumeIntents(): string[] { return (this.authority.db.prepare("SELECT i.intent_id FROM pre_gjc_resume_intents i JOIN live_supervisor_live_resume_config c ON c.project_id=i.project_id AND c.enabled=1 AND c.provider=i.provider AND c.terminal_id=i.terminal_handle AND c.session_id=i.session_id AND c.incarnation_id=i.incarnation_id AND c.pty_id=i.pty_id AND c.worktree_id=i.worktree_id JOIN live_supervisor_live_resume_config_audit a ON a.revision=c.revision AND a.project_id=c.project_id AND a.enabled=c.enabled AND a.config_digest=c.config_digest AND a.canonical_path=c.canonical_path AND a.provider=c.provider AND a.terminal_id=c.terminal_id AND a.session_id=c.session_id AND a.incarnation_id=c.incarnation_id AND a.pty_id=c.pty_id AND a.worktree_id=c.worktree_id JOIN live_supervisor_bindings b ON b.project_id=i.project_id AND b.canonical_path=c.canonical_path AND b.provider=i.provider AND b.terminal_id=i.terminal_handle AND b.session_id=i.session_id AND b.incarnation_id=i.incarnation_id AND b.pty_id=i.pty_id AND b.worktree_id=i.worktree_id WHERE i.state='pending' ORDER BY i.created_at,i.intent_id").all() as Row[]).map(row => String(row.intent_id)); }
  drainStructured(shadow: PreGjcShadow, now = new Date()): void {
    shadow.recoverCandidates(now);
    for (const binding of this.list()) {
      if (!binding.project_id || !binding.pty_id || !binding.worktree_id) continue;
      const claim = shadow.claimNext("live-supervisor", now, 60_000, binding.provider, binding.canonical_path, binding.terminal_id, binding.incarnation_id); if (claim) shadow.stageCandidate(claim, binding.project_id, now);
      const row = this.authority.db.prepare("SELECT candidate_id,fencing_token,payload_json FROM pre_gjc_candidates WHERE project_id=? AND terminal_handle=? AND provider=? AND incarnation_id=? AND state='staged' ORDER BY staged_at DESC,candidate_id DESC LIMIT 1").get(binding.project_id, binding.terminal_id, binding.provider, binding.incarnation_id) as Row | undefined;
      if (!row) continue; let signal: Record<string, unknown>; try { signal = JSON.parse(String(row.payload_json)) as Record<string, unknown>; } catch { continue; }
      const state = signal.state;
      if (state === "approval_required" || state === "needs_input") {
        shadow.requestAuthority({ project_id: binding.project_id, provider: binding.provider, terminal_id: binding.terminal_id, session_id: binding.session_id, incarnation_id: binding.incarnation_id, signal_event_id: String(signal.event_id), attempt_id: String(row.candidate_id), lease_id: String(row.candidate_id), fence: Number(row.fencing_token), expires_at: new Date(now.getTime() + 5 * 60_000).toISOString(), pty_id: binding.pty_id, worktree_id: binding.worktree_id, prompt_digest: resumePromptDigest(binding), authority_kind: state }, now);
      } else if (state === "stopped") {
        shadow.requestPolicyResume({ project_id: binding.project_id, provider: binding.provider, terminal_id: binding.terminal_id, session_id: binding.session_id, incarnation_id: binding.incarnation_id, pty_id: binding.pty_id, worktree_id: binding.worktree_id, candidate_id: String(row.candidate_id), candidate_fence: Number(row.fencing_token), prompt_digest: resumePromptDigest(binding) }, now);
      }
    }
  }
  async cycleWithShadow(shadow: PreGjcShadow, observe: LiveObservationReader, now = new Date().toISOString()): Promise<LiveSupervisorCycle> {
    // An unacknowledged output must be replayed before staging more input.  This
    // keeps the internal source receipt and its live output in one durable unit.
    if (!this.authority.db.prepare("SELECT 1 FROM live_supervisor_reports r LEFT JOIN live_supervisor_report_receipts d ON d.report_id=r.report_id WHERE d.report_id IS NULL LIMIT 1").get()) this.drainStructured(shadow, new Date(now));
    return this.cycleAll(observe, now);
  }
  async cycleAll(observe: LiveObservationReader, now = new Date().toISOString()): Promise<LiveSupervisorCycle> {
    const recovered = this.authority.db.prepare("SELECT r.report_id,r.payload_json,r.payload_digest FROM live_supervisor_reports r LEFT JOIN live_supervisor_report_receipts d ON d.report_id=r.report_id WHERE d.report_id IS NULL ORDER BY r.created_at,r.report_id LIMIT 1").get() as Row | undefined;
    if (recovered) return { report: null, authority_items: [], resume_candidates: [], recovered_report: this.report(recovered) };
    const bindings = this.list(); if (bindings.length === 0) throw new JarvisError("LIVE_WORKTREE_UNREGISTERED");
    const observed = (await Promise.all(bindings.map(async binding => ({ binding, values: await observe(binding) })))).flatMap(item => item.values.map(value => ({ binding: item.binding, value })));
    return this.tx(() => {
      const changes: Array<Record<string, unknown>> = []; const authority_items: string[] = []; const resume_candidates: string[] = [];
      const seen = new Set<string>(); for (const { binding, value } of observed) {
        const key = `${binding.canonical_path}\0${binding.provider}\0${binding.terminal_id}`; if (seen.has(key)) throw new JarvisError("LIVE_OBSERVATION_DUPLICATE"); seen.add(key);
        if (value.provider !== binding.provider || value.terminal_id !== binding.terminal_id || value.session_id !== binding.session_id || value.incarnation_id !== binding.incarnation_id || !states.has(value.state) || (value.cursor !== null && !nonempty(value.cursor))) throw new JarvisError("LIVE_OBSERVATION_INVALID");
        const projection = this.authority.db.prepare("SELECT state FROM progress_projection WHERE worktree_selector=? AND provider=? AND terminal_handle=? AND incarnation_id=?").get(binding.canonical_path, binding.provider, binding.terminal_id, binding.incarnation_id) as Row | undefined;
        const state = projection ? String(projection.state) as ProgressState : value.state;
        const observation_digest = digest({ worktree: binding.canonical_path, provider: value.provider, terminal_id: value.terminal_id, session_id: value.session_id, incarnation_id: value.incarnation_id, cursor: value.cursor, state });
        const prior = this.authority.db.prepare("SELECT next_cursor,session_id,incarnation_id,projection_state,observation_digest FROM live_supervisor_cursors WHERE canonical_path=? AND provider=? AND terminal_id=?").get(binding.canonical_path, binding.provider, binding.terminal_id) as Row | undefined;
        if (!prior || prior.next_cursor !== value.cursor || prior.session_id !== value.session_id || prior.incarnation_id !== value.incarnation_id || prior.projection_state !== state || prior.observation_digest !== observation_digest) changes.push({ worktree: binding.canonical_path, provider: value.provider, terminal_id: value.terminal_id, session_id: value.session_id, incarnation_id: value.incarnation_id, cursor: value.cursor, state });
        this.authority.db.prepare("INSERT INTO live_supervisor_cursors(canonical_path,provider,terminal_id,session_id,incarnation_id,next_cursor,updated_at,projection_state,observation_digest) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(canonical_path,provider,terminal_id) DO UPDATE SET session_id=excluded.session_id,incarnation_id=excluded.incarnation_id,next_cursor=excluded.next_cursor,updated_at=excluded.updated_at,projection_state=excluded.projection_state,observation_digest=excluded.observation_digest").run(binding.canonical_path, value.provider, value.terminal_id, value.session_id, value.incarnation_id, value.cursor, now, state, observation_digest);
      }
      const sourceRows = this.authority.db.prepare("SELECT s.candidate_id,s.progress_report_id,s.pre_gjc_report_id FROM live_supervisor_candidate_report_sources s JOIN pre_gjc_candidates c ON c.candidate_id=s.candidate_id JOIN live_supervisor_bindings b ON b.canonical_path=c.worktree_selector AND b.provider=c.provider AND b.terminal_id=c.terminal_handle AND b.incarnation_id=c.incarnation_id LEFT JOIN live_supervisor_report_sources linked ON linked.candidate_id=s.candidate_id WHERE linked.candidate_id IS NULL ORDER BY s.candidate_id").all() as Row[];
      const sources = sourceRows.map(source => ({ candidate_id: String(source.candidate_id), progress_report_id: typeof source.progress_report_id === "string" ? source.progress_report_id : null, pre_gjc_report_id: String(source.pre_gjc_report_id) }));
      const sorted = changes.sort((a, b) => canonicalize(a).localeCompare(canonicalize(b))); if (sorted.length === 0 && sources.length === 0) return { report: null, authority_items: [...new Set(authority_items)].sort(), resume_candidates: [...new Set(resume_candidates)].sort(), recovered_report: null };
      const payload = canonicalize({ version: 2, worktrees: [...new Set(bindings.map(binding => binding.canonical_path))].sort(), changes: sorted, sources }); const payload_digest = digest(payload); const report_id = id("live_report", payload_digest);
      this.authority.db.prepare("INSERT INTO live_supervisor_reports(report_id,canonical_path,payload_json,payload_digest,created_at) VALUES(?,?,?,?,?)").run(report_id, "*", payload, payload_digest, now);
      for (const source of sources) this.authority.db.prepare("INSERT INTO live_supervisor_report_sources(report_id,candidate_id,progress_report_id,pre_gjc_report_id) VALUES(?,?,?,?)").run(report_id, source.candidate_id, source.progress_report_id, source.pre_gjc_report_id);
      return { report: { report_id, payload_json: payload, payload_digest }, authority_items: [...new Set(authority_items)].sort(), resume_candidates: [...new Set(resume_candidates)].sort(), recovered_report: null };
    });
  }
}
