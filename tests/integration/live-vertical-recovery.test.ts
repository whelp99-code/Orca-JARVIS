import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { execute } from "../../src/cli.js";
import { AuthorityDb } from "../../src/db.js";
import { PreGjcShadow } from "../../src/pre-gjc-shadow.js";

type Provider = "codex" | "claude";
const iso = (value: number) => new Date(value).toISOString();
const eventId = (input: { provider: Provider; terminal_id: string; incarnation_id: string; cursor: string | null; sequence: string; state: string; reason_code: string; observed_at: string }) => `sha256:${createHash("sha256").update(JSON.stringify(["progress-signal-event/v1", "provider_bridge", input.provider, input.terminal_id, input.incarnation_id, input.cursor, input.sequence, input.state, input.reason_code, true, input.observed_at]), "utf8").digest("hex")}`;
const publicPem = (key: KeyObject) => key.export({ type: "spki", format: "pem" }).toString();

function signedSignal(key: KeyObject, provider: Provider, terminal: string, incarnation: string, sequence: string, state: "approval_required" | "needs_input" | "verifying" | "stopped", observedAt: string, keyId: string) {
  const reason = provider === "codex"
    ? ({ approval_required: "codex_exec_approval", needs_input: "codex_user_input_request", verifying: "jarvis_canonical_verify_active", stopped: "jarvis_canonical_final_stopped" } as const)[state]
    : ({ approval_required: "claude_permission_request", needs_input: "claude_user_question", verifying: "jarvis_canonical_verify_active", stopped: "jarvis_canonical_final_stopped" } as const)[state];
  const unsigned = { schema_version: 1 as const, source: "provider_bridge" as const, provider, terminal_id: terminal, incarnation_id: incarnation, cursor: `cursor-${sequence}`, sequence, state, reason_code: reason, active: true as const, observed_at: observedAt, key_id: keyId, algorithm: "Ed25519" as const };
  const payload = { ...unsigned, event_id: eventId(unsigned) };
  return { ...payload, signature: sign(null, Buffer.concat([Buffer.from("orca-jarvis/progress-signal/v1\0", "ascii"), Buffer.from(canonicalize(payload), "utf8")]), key).toString("base64url") };
}

function signedReceipt(key: KeyObject, request: Record<string, unknown>, decision: "approve" | "reject" | "needs_input", now: Date) {
  const payload = {
    receipt_id: `receipt-${String(request.request_id)}-${decision}`,
    request_id: request.request_id, project_id: request.project_id, provider: request.provider,
    terminal_id: request.terminal_handle, session_id: request.session_id, incarnation_id: request.incarnation_id,
    signal_event_id: request.signal_event_id, attempt_id: request.attempt_id, lease_id: request.lease_id,
    fence: request.fence, pty_id: request.pty_id, worktree_id: request.worktree_id,
    prompt_digest: request.prompt_digest, authority_kind: request.authority_kind,
    decision, ...(decision === "needs_input" ? { answer: "continue within the already authorized scope" } : {}),
    key_id: "authority-key", issued_at: iso(now.getTime() - 172_800_000), expires_at: iso(now.getTime() + 5 * 60_000)
  };
  return { ...payload, signature: sign(null, Buffer.from(`orca-jarvis/pre-gjc-authority/v1\0${canonicalize(payload)}`), key).toString("base64url") };
}

describe("live signed vertical and recovery", () => {
  it("consolidates signed reports and sends each human or policy resume exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-live-vertical-"));
    const codexWorktree = join(root, "codex-worktree"); const claudeWorktree = join(root, "claude-worktree"); const rogueWorktree = join(root, "rogue-worktree"); mkdirSync(codexWorktree); mkdirSync(claudeWorktree); mkdirSync(rogueWorktree);
    const db = join(root, "authority.sqlite"); const frozen = new Date(Date.now() + 86_400_000); const clock = () => new Date(frozen.getTime());
    const decision = generateKeyPairSync("ed25519"); const verifier = generateKeyPairSync("ed25519"); const progress = generateKeyPairSync("ed25519"); const authority = generateKeyPairSync("ed25519");
    const decisionPublic = join(root, "decision.pub.pem"); const verifierPublic = join(root, "verifier.pub.pem");
    writeFileSync(decisionPublic, publicPem(decision.publicKey)); writeFileSync(verifierPublic, publicPem(verifier.publicKey));
    const writeJson = (name: string, value: unknown) => { const file = join(root, name); writeFileSync(file, JSON.stringify(value)); return file; };
    const codexBinding = writeJson("codex-binding.json", { worktree: codexWorktree, provider: "codex", terminal_id: "codex-terminal", session_id: "codex-session", incarnation_id: "codex-incarnation", pty_id: "codex-pty", worktree_id: "codex-worktree-id", project_id: "codex-project" });
    const claudeBinding = writeJson("claude-binding.json", { worktree: claudeWorktree, provider: "claude", terminal_id: "claude-terminal", session_id: "claude-session", incarnation_id: "claude-incarnation", pty_id: "claude-pty", worktree_id: "claude-worktree-id", project_id: "claude-project" });
    const rogueBinding = writeJson("rogue-binding.json", { worktree: rogueWorktree, provider: "codex", terminal_id: "rogue-terminal", session_id: "rogue-session", incarnation_id: "rogue-incarnation", pty_id: "rogue-pty", worktree_id: "rogue-worktree-id", project_id: "codex-project" });
    const calls: string[][] = [];
    const runner = async (args: readonly string[]) => {
      const terminal = args[1] === "list" ? undefined : String(args[3]);
      if (args[1] === "list") return JSON.stringify({ ok: true, result: { terminals: [
        { handle: "codex-terminal", ptyId: "codex-pty", incarnationId: "codex-incarnation", worktreeId: "codex-worktree-id", worktreePath: null, title: "Codex", connected: true, writable: true, lastOutputAt: null, preview: null },
        { handle: "claude-terminal", ptyId: "claude-pty", incarnationId: "claude-incarnation", worktreeId: "claude-worktree-id", worktreePath: null, title: "Claude", connected: true, writable: true, lastOutputAt: null, preview: null },
        { handle: "rogue-terminal", ptyId: "rogue-pty", incarnationId: "rogue-incarnation", worktreeId: "rogue-worktree-id", worktreePath: null, title: "Rogue", connected: true, writable: true, lastOutputAt: null, preview: null }
      ] } });
      return JSON.stringify({ ok: true, result: { terminal: { handle: terminal, status: "ok", tail: [], truncated: false, limited: false, oldestCursor: null, nextCursor: `read-${terminal}`, latestCursor: `read-${terminal}`, returnedLineCount: 0 } } });
    };
    const liveCommand = (args: readonly string[]) => {
      calls.push([...args]); const terminal = String(args[3]);
      if (args[1] === "show") return JSON.stringify({ ok: true, result: { terminal: { handle: terminal, incarnationId: terminal === "codex-terminal" ? "codex-incarnation" : terminal === "claude-terminal" ? "claude-incarnation" : "rogue-incarnation", ptyId: terminal === "codex-terminal" ? "codex-pty" : terminal === "claude-terminal" ? "claude-pty" : "rogue-pty", worktreeId: terminal === "codex-terminal" ? "codex-worktree-id" : terminal === "claude-terminal" ? "claude-worktree-id" : "rogue-worktree-id", connected: true, writable: true } } });
      return JSON.stringify({ ok: true, result: { accepted: true } });
    };
    const run = (args: string[]) => execute(args, { orcaRunner: runner, liveOrcaCommand: liveCommand, clock });
    try {
      await run(["init", "--db", db, "--decision_public", decisionPublic, "--decision_key_id", "decision-anchor", "--decision_principal", "operator", "--verifier_public", verifierPublic, "--verifier_key_id", "verifier-anchor", "--verifier_principal", "independent"]);
      await run(["pre-gjc", "projects", "configure", writeJson("codex-project.json", { project_id: "codex-project", provider: "codex", token_budget: 20, cache_budget: 20 }), "--db", db]);
      await run(["pre-gjc", "projects", "configure", writeJson("claude-project.json", { project_id: "claude-project", provider: "claude", token_budget: 20, cache_budget: 20 }), "--db", db]);
      await run(["project", "register", codexBinding, "--db", db]); await run(["project", "register", claudeBinding, "--db", db]);
      await run(["project", "live-resume", "codex-project", "enable", "--db", db]); await run(["project", "live-resume", "claude-project", "enable", "--db", db]);
      // This binding is deliberately added after codex-project has been enabled.
      // It must never inherit the original terminal's resume authority.
      await run(["project", "register", rogueBinding, "--db", db]);
      for (const provider of ["codex", "claude"] as const) {
        await run(["pre-gjc", "keys", "register", writeJson(`${provider}-progress.json`, { key_id: `${provider}-progress`, provider, purpose: "progress-signal", public_key_pem: publicPem(progress.publicKey), active: true, not_before: iso(frozen.getTime() - 172_800_000), expires_at: iso(frozen.getTime() + 3_600_000) }), "--db", db]);
        await run(["pre-gjc", "keys", "register", writeJson(`${provider}-authority.json`, { key_id: "authority-key", provider, purpose: "authority-receipt", public_key_pem: publicPem(authority.publicKey), active: true, not_before: iso(frozen.getTime() - 172_800_000), expires_at: iso(frozen.getTime() + 3_600_000) }), "--db", db]);
      }
      const ingest = async (worktree: string, name: string, signal: unknown) => run(["pre-gjc", "candidates", "ingest", worktree, writeJson(name, { progress_signal: signal }), "--db", db]);
      const ack = async (result: Record<string, unknown>) => { const report = (result.recovered_report ?? result.report) as { report_id: string } | null; expect(report, JSON.stringify(result)).not.toBeNull(); await run(["report", "ack", report!.report_id, "--db", db]); };

      // Settle the initial read-only unknown projection before injecting a
      // structured signal.  It is not a resume input and must not affect sends.
      await ack(await run(["supervisor", "once", "--db", db]));

      const approval = signedSignal(progress.privateKey, "codex", "codex-terminal", "codex-incarnation", "1", "approval_required", iso(frozen.getTime() - 500), "codex-progress");
      await ingest(codexWorktree, "approval.json", approval); const stagedApproval = await run(["supervisor", "once", "--db", db]); const stagedDebug = new AuthorityDb(db); const stagedRows = { candidates: stagedDebug.db.prepare("SELECT candidate_id,state,project_id,next_attempt_at FROM pre_gjc_candidates").all(), sources: stagedDebug.db.prepare("SELECT * FROM live_supervisor_candidate_report_sources").all(), bindings: stagedDebug.db.prepare("SELECT canonical_path,provider,terminal_id,project_id FROM live_supervisor_bindings").all() }; stagedDebug.close(); expect(stagedApproval.report, JSON.stringify(stagedRows)).not.toBeNull(); await ack(stagedApproval);
      const direct = new AuthorityDb(db); const request = direct.db.prepare("SELECT * FROM pre_gjc_authority_requests WHERE project_id='codex-project' AND signal_event_id=?").get(approval.event_id) as Record<string, unknown> | undefined; expect(request).toBeDefined(); direct.close();
      const receipt = signedReceipt(authority.privateKey, request!, "approve", frozen); await run(["approval", "ingest", writeJson("approval-receipt.json", receipt), "--db", db]);
      await run(["supervisor", "once", "--db", db]);
      expect(calls).toEqual([
        ["terminal", "show", "--terminal", "codex-terminal", "--json"],
        ["terminal", "send", "--terminal", "codex-terminal", "--text", "Resume only the already-authorized bounded work. Do not widen scope or perform external actions.", "--enter", "--json"]
      ]);

      // Restart and replay the exact signed inputs: all durable identities are
      // reused, so neither a second authority request nor terminal send appears.
      await ingest(codexWorktree, "approval-replay.json", approval); await run(["approval", "ingest", writeJson("approval-replay-receipt.json", receipt), "--db", db]); await run(["supervisor", "once", "--db", db]);
      expect(calls).toEqual([
        ["terminal", "show", "--terminal", "codex-terminal", "--json"],
        ["terminal", "send", "--terminal", "codex-terminal", "--text", "Resume only the already-authorized bounded work. Do not widen scope or perform external actions.", "--enter", "--json"]
      ]);
      const reopened = new AuthorityDb(db); expect(Number((reopened.db.prepare("SELECT COUNT(*) AS count FROM pre_gjc_authority_requests WHERE project_id='codex-project'").get() as { count: number }).count)).toBe(1); reopened.close();

      const rogueApproval = signedSignal(progress.privateKey, "codex", "rogue-terminal", "rogue-incarnation", "1", "approval_required", iso(frozen.getTime() - 450), "codex-progress");
      await ingest(rogueWorktree, "rogue-approval.json", rogueApproval); const stagedRogueApproval = await run(["supervisor", "once", "--db", db]); await ack(stagedRogueApproval);
      const rogueDb = new AuthorityDb(db); const rogueRequest = rogueDb.db.prepare("SELECT * FROM pre_gjc_authority_requests WHERE terminal_handle='rogue-terminal'").get() as Record<string, unknown>; rogueDb.close();
      const rogueIntent = (await run(["approval", "ingest", writeJson("rogue-approval-receipt.json", signedReceipt(authority.privateKey, rogueRequest, "approve", frozen)), "--db", db])).intent_id as string;
      await expect(run(["resume", "deliver", rogueIntent, "--db", db])).rejects.toThrow("ORCA_RESUME_DISABLED");
      expect(calls).toHaveLength(2);

      const rogueStopped = signedSignal(progress.privateKey, "codex", "rogue-terminal", "rogue-incarnation", "2", "stopped", iso(frozen.getTime() - 425), "codex-progress");
      await ingest(rogueWorktree, "rogue-stopped.json", rogueStopped); const stagedRogueStopped = await run(["supervisor", "once", "--db", db]); await ack(stagedRogueStopped);
      const blockedRogue = new AuthorityDb(db); const rogueCandidate = blockedRogue.db.prepare("SELECT candidate_id,fencing_token FROM pre_gjc_candidates WHERE payload_json LIKE ?").get(`%${rogueStopped.event_id}%`) as { candidate_id: string; fencing_token: number }; expect(rogueCandidate).toBeDefined(); expect(new PreGjcShadow(blockedRogue).requestPolicyResume({ project_id: "codex-project", provider: "codex", terminal_id: "rogue-terminal", session_id: "rogue-session", incarnation_id: "rogue-incarnation", pty_id: "rogue-pty", worktree_id: "rogue-worktree-id", candidate_id: rogueCandidate.candidate_id, candidate_fence: rogueCandidate.fencing_token, prompt_digest: "sha256:rogue" }, frozen)).toBeUndefined(); expect(blockedRogue.db.prepare("SELECT reason FROM pre_gjc_policy_resume_blocks WHERE terminal_handle='rogue-terminal'").get()).toMatchObject({ reason: "live_policy_binding_mismatch" }); expect(blockedRogue.db.prepare("SELECT 1 FROM pre_gjc_policy_resume_intents WHERE terminal_handle='rogue-terminal'").get()).toBeUndefined(); blockedRogue.close();
      expect(calls).toHaveLength(2);

      // The second signal is staged after the first live ACK and restart.  Its
      // internal reports are linked to exactly one new live report and ACKed.
      const verifying = signedSignal(progress.privateKey, "codex", "codex-terminal", "codex-incarnation", "2", "verifying", iso(frozen.getTime() - 400), "codex-progress");
      await ingest(codexWorktree, "verifying.json", verifying); const stagedVerifying = await run(["supervisor", "once", "--db", db]); await ack(stagedVerifying); await run(["supervisor", "once", "--db", db]);
      const recovery = new AuthorityDb(db); expect(Number((recovery.db.prepare("SELECT COUNT(*) AS count FROM live_supervisor_report_sources").get() as { count: number }).count)).toBe(4); expect(Number((recovery.db.prepare("SELECT COUNT(*) AS count FROM progress_report_outbox p LEFT JOIN progress_delivery_receipts d ON d.report_id=p.report_id WHERE d.report_id IS NULL").get() as { count: number }).count)).toBe(0); recovery.close();

      const stopped = signedSignal(progress.privateKey, "claude", "claude-terminal", "claude-incarnation", "1", "stopped", iso(frozen.getTime() - 300), "claude-progress");
      await ingest(claudeWorktree, "stopped.json", stopped); const stagedStopped = await run(["supervisor", "once", "--db", db]); await ack(stagedStopped);
      expect(calls.slice(2)).toEqual([
        ["terminal", "show", "--terminal", "claude-terminal", "--json"],
        ["terminal", "send", "--terminal", "claude-terminal", "--text", "Resume only the already-authorized bounded work. Do not widen scope or perform external actions.", "--enter", "--json"]
      ]);
      await run(["supervisor", "once", "--db", db]); expect(calls).toHaveLength(4);
      const final = new AuthorityDb(db); expect(Number((final.db.prepare("SELECT COUNT(*) AS count FROM pre_gjc_policy_resume_intents WHERE state='pending'").get() as { count: number }).count)).toBe(0); expect(Number((final.db.prepare("SELECT COUNT(*) AS count FROM pre_gjc_policy_resume_intents WHERE state='delivered'").get() as { count: number }).count)).toBe(1); final.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20_000);

  it("auto-delivers one policy resume and does not resend it after replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-policy-auto-red-")); const worktree = join(root, "worktree"); mkdirSync(worktree); const db = join(root, "authority.sqlite"); const frozen = new Date(Date.now() + 86_400_000); const clock = () => new Date(frozen.getTime());
    const decision = generateKeyPairSync("ed25519"); const verifier = generateKeyPairSync("ed25519"); const progress = generateKeyPairSync("ed25519"); const decisionPublic = join(root, "decision.pub.pem"); const verifierPublic = join(root, "verifier.pub.pem"); writeFileSync(decisionPublic, publicPem(decision.publicKey)); writeFileSync(verifierPublic, publicPem(verifier.publicKey));
    const writeJson = (name: string, value: unknown) => { const file = join(root, name); writeFileSync(file, JSON.stringify(value)); return file; };
    const runner = async (args: readonly string[]) => args[1] === "list"
      ? JSON.stringify({ ok: true, result: { terminals: [{ handle: "policy-terminal", ptyId: "policy-pty", incarnationId: "policy-incarnation", worktreeId: "policy-worktree-id", worktreePath: null, title: "Codex", connected: true, writable: true, lastOutputAt: null, preview: null }] } })
      : JSON.stringify({ ok: true, result: { terminal: { handle: "policy-terminal", status: "ok", tail: [], truncated: false, limited: false, oldestCursor: null, nextCursor: "policy-read", latestCursor: "policy-read", returnedLineCount: 0 } } });
    const calls: string[][] = []; const liveCommand = (args: readonly string[]) => { calls.push([...args]); return args[1] === "show" ? JSON.stringify({ ok: true, result: { terminal: { handle: "policy-terminal", incarnationId: "policy-incarnation", ptyId: "policy-pty", worktreeId: "policy-worktree-id", connected: true, writable: true } } }) : JSON.stringify({ ok: true, result: { accepted: true } }); };
    const run = (args: string[]) => execute(args, { orcaRunner: runner, liveOrcaCommand: liveCommand, clock });
    const ack = async (result: Record<string, unknown>) => { const report = (result.recovered_report ?? result.report) as { report_id: string } | null; expect(report, JSON.stringify(result)).not.toBeNull(); await run(["report", "ack", report!.report_id, "--db", db]); };
    try {
      await run(["init", "--db", db, "--decision_public", decisionPublic, "--decision_key_id", "decision-anchor", "--decision_principal", "operator", "--verifier_public", verifierPublic, "--verifier_key_id", "verifier-anchor", "--verifier_principal", "independent"]);
      await run(["pre-gjc", "projects", "configure", writeJson("project.json", { project_id: "policy-project", provider: "codex", token_budget: 20, cache_budget: 20 }), "--db", db]);
      await run(["project", "register", writeJson("binding.json", { worktree, provider: "codex", terminal_id: "policy-terminal", session_id: "policy-session", incarnation_id: "policy-incarnation", pty_id: "policy-pty", worktree_id: "policy-worktree-id", project_id: "policy-project" }), "--db", db]);
      await run(["project", "live-resume", "policy-project", "enable", "--db", db]);
      await run(["pre-gjc", "keys", "register", writeJson("progress-key.json", { key_id: "policy-progress", provider: "codex", purpose: "progress-signal", public_key_pem: publicPem(progress.publicKey), active: true, not_before: iso(frozen.getTime() - 172_800_000), expires_at: iso(frozen.getTime() + 3_600_000) }), "--db", db]);
      await ack(await run(["supervisor", "once", "--db", db]));
      const stopped = signedSignal(progress.privateKey, "codex", "policy-terminal", "policy-incarnation", "1", "stopped", iso(frozen.getTime() - 300), "policy-progress"); const envelopeFile = writeJson("stopped.json", { progress_signal: stopped });
      await run(["pre-gjc", "candidates", "ingest", worktree, envelopeFile, "--db", db]); await ack(await run(["supervisor", "once", "--db", db]));
      expect(calls).toEqual([
        ["terminal", "show", "--terminal", "policy-terminal", "--json"],
        ["terminal", "send", "--terminal", "policy-terminal", "--text", "Resume only the already-authorized bounded work. Do not widen scope or perform external actions.", "--enter", "--json"],
      ]);
      await run(["pre-gjc", "candidates", "ingest", worktree, envelopeFile, "--db", db]); await run(["supervisor", "once", "--db", db]);
      expect(calls).toHaveLength(2);
      const reopened = new AuthorityDb(db); expect(reopened.db.prepare("SELECT state,attempts FROM pre_gjc_policy_resume_intents").get()).toMatchObject({ state: "delivered", attempts: 1 }); reopened.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20_000);
});
