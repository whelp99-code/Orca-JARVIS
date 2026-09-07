import { type AuthorityDb, JarvisError } from "./db.js";
import type { LiveBinding } from "./live-supervisor.js";
import type { PreGjcShadow } from "./pre-gjc-shadow.js";
import { listLiveBindings } from "./live-supervisor-bindings.js";
import { digest, liveSupervisorTransaction, type Row } from "./live-supervisor-shared.js";
const resumePromptDigest = (binding: LiveBinding) =>
  digest({
    provider: binding.provider,
    terminal_id: binding.terminal_id,
    session_id: binding.session_id,
    incarnation_id: binding.incarnation_id,
    pty_id: binding.pty_id,
    worktree_id: binding.worktree_id,
    prompt: "Resume only the already-authorized bounded work. Do not widen scope or perform external actions.",
  });
export function configureLiveResume(authority: AuthorityDb, projectId: string, enabled: boolean, now = new Date()): void {
  const bindings = authority.db
    .prepare(
      `SELECT canonical_path, provider, terminal_id, session_id, incarnation_id, pty_id, worktree_id FROM
        live_supervisor_bindings WHERE project_id=? AND pty_id IS NOT NULL AND worktree_id IS NOT NULL ORDER BY
        canonical_path, provider, terminal_id`,
    )
    .all(projectId) as Row[];
  if (bindings.length !== 1) throw new JarvisError("LIVE_RESUME_CONFIG_INVALID");
  const binding = bindings[0]!;
  const configured_at = now.toISOString();
  const config_digest = digest({
    project_id: projectId,
    enabled,
    canonical_path: binding.canonical_path,
    provider: binding.provider,
    terminal_id: binding.terminal_id,
    session_id: binding.session_id,
    incarnation_id: binding.incarnation_id,
    pty_id: binding.pty_id,
    worktree_id: binding.worktree_id,
  });
  liveSupervisorTransaction(authority, () => {
    const inserted = authority.db
      .prepare(
        `INSERT INTO live_supervisor_live_resume_config_audit(project_id, enabled, config_digest, created_at,
          canonical_path, provider, terminal_id, session_id, incarnation_id, pty_id, worktree_id) VALUES(?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        enabled ? 1 : 0,
        config_digest,
        configured_at,
        binding.canonical_path,
        binding.provider,
        binding.terminal_id,
        binding.session_id,
        binding.incarnation_id,
        binding.pty_id,
        binding.worktree_id,
      );
    const revision = Number(inserted.lastInsertRowid);
    authority.db
      .prepare(
        `INSERT INTO live_supervisor_live_resume_config(project_id, enabled, configured_at, revision, config_digest,
          canonical_path, provider, terminal_id, session_id, incarnation_id, pty_id, worktree_id) VALUES(?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled,
          configured_at=excluded.configured_at, revision=excluded.revision, config_digest=excluded.config_digest,
          canonical_path=excluded.canonical_path, provider=excluded.provider, terminal_id=excluded.terminal_id,
          session_id=excluded.session_id, incarnation_id=excluded.incarnation_id, pty_id=excluded.pty_id,
          worktree_id=excluded.worktree_id`,
      )
      .run(
        projectId,
        enabled ? 1 : 0,
        configured_at,
        revision,
        config_digest,
        binding.canonical_path,
        binding.provider,
        binding.terminal_id,
        binding.session_id,
        binding.incarnation_id,
        binding.pty_id,
        binding.worktree_id,
      );
  });
}

export function liveResumeConfigured(authority: AuthorityDb): boolean {
  return Boolean(
    authority.db
      .prepare(
        `SELECT 1 FROM live_supervisor_live_resume_config c JOIN live_supervisor_live_resume_config_audit a ON
          a.revision=c.revision AND a.project_id=c.project_id AND a.enabled=c.enabled AND a.config_digest=c.config_digest
          AND a.canonical_path=c.canonical_path AND a.provider=c.provider AND a.terminal_id=c.terminal_id AND
          a.session_id=c.session_id AND a.incarnation_id=c.incarnation_id AND a.pty_id=c.pty_id AND
          a.worktree_id=c.worktree_id JOIN live_supervisor_bindings b ON b.project_id=c.project_id AND
          b.canonical_path=c.canonical_path AND b.provider=c.provider AND b.terminal_id=c.terminal_id AND
          b.session_id=c.session_id AND b.incarnation_id=c.incarnation_id AND b.pty_id=c.pty_id AND
          b.worktree_id=c.worktree_id WHERE c.enabled=1 LIMIT 1`,
      )
      .get(),
  );
}

export function pendingLiveResumeIntents(authority: AuthorityDb): string[] {
  return (
    authority.db
      .prepare(
        `SELECT i.intent_id FROM pre_gjc_resume_intents i JOIN live_supervisor_live_resume_config c ON
          c.project_id=i.project_id AND c.enabled=1 AND c.provider=i.provider AND c.terminal_id=i.terminal_handle AND
          c.session_id=i.session_id AND c.incarnation_id=i.incarnation_id AND c.pty_id=i.pty_id AND
          c.worktree_id=i.worktree_id JOIN live_supervisor_live_resume_config_audit a ON a.revision=c.revision AND
          a.project_id=c.project_id AND a.enabled=c.enabled AND a.config_digest=c.config_digest AND
          a.canonical_path=c.canonical_path AND a.provider=c.provider AND a.terminal_id=c.terminal_id AND
          a.session_id=c.session_id AND a.incarnation_id=c.incarnation_id AND a.pty_id=c.pty_id AND
          a.worktree_id=c.worktree_id JOIN live_supervisor_bindings b ON b.project_id=i.project_id AND
          b.canonical_path=c.canonical_path AND b.provider=i.provider AND b.terminal_id=i.terminal_handle AND
          b.session_id=i.session_id AND b.incarnation_id=i.incarnation_id AND b.pty_id=i.pty_id AND
          b.worktree_id=i.worktree_id WHERE i.state='pending' ORDER BY i.created_at, i.intent_id`,
      )
      .all() as Row[]
  ).map((row) => String(row.intent_id));
}

export function drainLiveStructured(authority: AuthorityDb, shadow: PreGjcShadow, now = new Date()): void {
  shadow.recoverCandidates(now);
  for (const binding of listLiveBindings(authority)) {
    if (!binding.project_id || !binding.pty_id || !binding.worktree_id) continue;
    const claim = shadow.claimNext(
      "live-supervisor",
      now,
      60_000,
      binding.provider,
      binding.canonical_path,
      binding.terminal_id,
      binding.incarnation_id,
    );
    if (claim) shadow.stageCandidate(claim, binding.project_id, now);
    const row = authority.db
      .prepare(
        `SELECT candidate_id, fencing_token, payload_json FROM pre_gjc_candidates WHERE project_id=? AND terminal_handle=?
          AND provider=? AND incarnation_id=? AND state='staged' ORDER BY staged_at DESC, candidate_id DESC LIMIT 1`,
      )
      .get(binding.project_id, binding.terminal_id, binding.provider, binding.incarnation_id) as Row | undefined;
    if (!row) continue;
    let signal: Record<string, unknown>;
    try {
      signal = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
    } catch {
      continue;
    }
    const state = signal.state;
    if (state === "approval_required" || state === "needs_input") {
      shadow.requestAuthority(
        {
          project_id: binding.project_id,
          provider: binding.provider,
          terminal_id: binding.terminal_id,
          session_id: binding.session_id,
          incarnation_id: binding.incarnation_id,
          signal_event_id: String(signal.event_id),
          attempt_id: String(row.candidate_id),
          lease_id: String(row.candidate_id),
          fence: Number(row.fencing_token),
          expires_at: new Date(now.getTime() + 5 * 60_000).toISOString(),
          pty_id: binding.pty_id,
          worktree_id: binding.worktree_id,
          prompt_digest: resumePromptDigest(binding),
          authority_kind: state,
        },
        now,
      );
    } else if (state === "stopped") {
      shadow.requestPolicyResume(
        {
          project_id: binding.project_id,
          provider: binding.provider,
          terminal_id: binding.terminal_id,
          session_id: binding.session_id,
          incarnation_id: binding.incarnation_id,
          pty_id: binding.pty_id,
          worktree_id: binding.worktree_id,
          candidate_id: String(row.candidate_id),
          candidate_fence: Number(row.fencing_token),
          prompt_digest: resumePromptDigest(binding),
        },
        now,
      );
    }
  }
}
