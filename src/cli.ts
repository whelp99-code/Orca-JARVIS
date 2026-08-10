#!/usr/bin/env node
import { createPrivateKey } from "node:crypto";
import { realpathSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AuthorityDb, JarvisError } from "./db.js";
import { discoverOrcaBindings, OrcaReadonlyAdapter, observeOrca, parseOrcaBindings, type OrcaRunner } from "./orca.js";
import { PreGjcShadow, type AuthorityReceipt, type AuthorityRequest, type ShadowKey } from "./pre-gjc-shadow.js";
import { ingestClaudeHookEvent, ingestCodexAppServerEvent } from "./adapters.js";
import { LiveSupervisor, type LiveBinding, type LiveObservation } from "./live-supervisor.js";
import { OrcaTerminalResumeAdapter, type OrcaCommand } from "./orca-resume.js";
import { GjcCoordinatorClient, type GjcRunner } from "./gjc.js";
import { GjcRuntimeService } from "./service.js";

function output(value: object): void { process.stdout.write(`${JSON.stringify({ version: 1, ...value })}\n`); }
function outputSync(value: object): void { writeSync(process.stdout.fd, `${JSON.stringify({ version: 1, ...value })}\n`); }
async function keyFor(db: AuthorityDb, path: string): Promise<ReturnType<typeof createPrivateKey>> { try { return createPrivateKey(await readFile(path, "utf8")); } catch { throw new JarvisError("SIGNING_KEY_MISSING", path); } }
async function jsonFile(path: string): Promise<unknown> { try { return JSON.parse(await readFile(path, "utf8")); } catch { throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID"); } }
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID"); return value as Record<string, unknown>; }
function integer(value: string | undefined): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID"); return parsed; }
async function observeBound(binding: LiveBinding, runner?: OrcaRunner): Promise<readonly LiveObservation[]> {
  // Read-only Orca evidence does not contain a signed provider ProgressSignal.
  // Its only safe classification is unknown; terminal prose is intentionally ignored.
  const adapter = new OrcaReadonlyAdapter(runner);
  const terminal = (await adapter.list(binding.canonical_path)).find(item => item.handle === binding.terminal_id && item.incarnationId === binding.incarnation_id && item.ptyId === binding.pty_id && item.worktreeId === binding.worktree_id);
  if (!terminal || !terminal.connected) return [{ provider: binding.provider, terminal_id: binding.terminal_id, session_id: binding.session_id, incarnation_id: binding.incarnation_id, cursor: binding.cursor, state: "unknown" }];
  const read = await adapter.read(binding.terminal_id, binding.cursor, 1);
  return [{ provider: binding.provider, terminal_id: binding.terminal_id, session_id: binding.session_id, incarnation_id: binding.incarnation_id, cursor: read.nextCursor, state: "unknown" }];
}
export async function execute(args: string[], dependencies: { orcaRunner?: OrcaRunner; liveOrcaCommand?: OrcaCommand; gjcRunner?: GjcRunner; clock?: () => Date } = {}): Promise<Record<string, unknown>> {
  const { values, positionals } = parseArgs({ args, options: { db: { type: "string" }, decision_public: { type: "string" }, decision_key_id: { type: "string" }, decision_principal: { type: "string" }, verifier_public: { type: "string" }, verifier_key_id: { type: "string" }, verifier_principal: { type: "string" }, json: { type: "boolean" }, once: { type: "boolean" }, crash: { type: "string" }, worktree: { type: "string" }, bindings: { type: "string" }, limit: { type: "string" }, max_pages: { type: "string" }, interval_ms: { type: "string" }, "interval-ms": { type: "string" }, live_resume: { type: "boolean" }, session_id: { type: "string" }, input: { type: "string" }, idempotency_key: { type: "string" }, allow_mutation: { type: "boolean" } }, allowPositionals: true, strict: false });
  const db = new AuthorityDb(typeof values.db === "string" ? values.db : undefined); const policyKeyPath = `${db.filename}.policy-key.pem`;
  try {
    const [command, subcommand, argument, fourth, fifth, sixth] = positionals;
    if (command === "init") { const decision = typeof values.decision_public === "string" && typeof values.decision_key_id === "string" && typeof values.decision_principal === "string" ? { publicKeyPath: values.decision_public, keyId: values.decision_key_id, principal: values.decision_principal } : undefined; const verifier = typeof values.verifier_public === "string" && typeof values.verifier_key_id === "string" && typeof values.verifier_principal === "string" ? { publicKeyPath: values.verifier_public, keyId: values.verifier_key_id, principal: values.verifier_principal } : undefined; await db.initialize({ decision, verifier }); return { ok: true, command: "init", policy_key_id: "local-policy-key", decision_configured: Boolean(decision), verifier_configured: Boolean(verifier) }; }
    if (command === "db" && subcommand === "migrate") { await db.migrate(); return { ok: true, command: "db.migrate" }; }
    await db.assertMigrationsReady();
    // These commands only stage, inspect, or acknowledge local shadow records.
    // In particular `authority consume` records a signed receipt but never calls
    // a terminal adapter; resumption is unavailable from this CLI surface.
    const shadow = new PreGjcShadow(db);
    const supervisor = new LiveSupervisor(db);
    const gjc = new GjcCoordinatorClient(dependencies.gjcRunner, true);
    const gjcService = new GjcRuntimeService(db, gjc, "gjc-runtime", async () => { try { await supervisor.cycleWithShadow(shadow, binding => observeBound(binding, dependencies.orcaRunner), (dependencies.clock?.() ?? new Date()).toISOString()); } catch (error) { if (!(error instanceof JarvisError) || error.code !== "LIVE_WORKTREE_UNREGISTERED") throw error; } });
    const preGjc = command === "pre-gjc" ? subcommand : command;
    const preSubcommand = command === "pre-gjc" ? argument : subcommand;
    const preArgument = command === "pre-gjc" ? fourth : argument;
    const preFourth = command === "pre-gjc" ? fifth : fourth;
    const preFifth = command === "pre-gjc" ? sixth : fifth;
    if (command === "project" && subcommand === "register" && argument) { const input = object(await jsonFile(argument)); const binding = supervisor.register({ worktree: String(input.worktree ?? ""), provider: input.provider as "codex" | "claude", terminal_id: String(input.terminal_id ?? ""), session_id: String(input.session_id ?? ""), incarnation_id: String(input.incarnation_id ?? ""), pty_id: typeof input.pty_id === "string" ? input.pty_id : undefined, worktree_id: typeof input.worktree_id === "string" ? input.worktree_id : undefined, project_id: typeof input.project_id === "string" ? input.project_id : undefined }); return { ok: true, command: "project.register", project: binding }; }
    if (command === "project" && subcommand === "discover") { const discovered = await discoverOrcaBindings(dependencies.orcaRunner); const projects = discovered.map(binding => supervisor.register(binding)); return { ok: true, command: "project.discover", projects }; }
    if (command === "project" && subcommand === "list") return { ok: true, command: "project.list", projects: supervisor.list() };
    if (command === "project" && subcommand === "live-resume" && argument && fourth) { supervisor.configureLiveResume(argument, fourth === "enable", dependencies.clock?.() ?? new Date()); return { ok: true, command: "project.live-resume", project_id: argument, enabled: fourth === "enable" }; }
    const runSupervisor = async () => { const now = dependencies.clock?.() ?? new Date(); const result = await supervisor.cycleWithShadow(shadow, binding => observeBound(binding, dependencies.orcaRunner), now.toISOString()); if (supervisor.liveResumeConfigured()) { const adapter = new OrcaTerminalResumeAdapter(db, true, dependencies.liveOrcaCommand, dependencies.clock); for (const intentId of supervisor.pendingLiveResumeIntents()) shadow.deliverResume(intentId, adapter, now); for (const intentId of shadow.pendingPolicyResumeIntents()) shadow.deliverPolicyResume(intentId, adapter, now); } return result; };
    if (command === "supervisor" && subcommand === "once") return { ok: true, command: "supervisor.once", ...(await runSupervisor()) };
    if (command === "supervisor" && subcommand === "watch") {
      const interval = values.interval_ms === undefined ? 10_000 : typeof values.interval_ms === "string" ? integer(values.interval_ms) : (() => { throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID"); })(); if (interval < 1 || interval > 60_000) throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID");
      const cycle = async () => {
        const result = await runSupervisor(); const report = result.recovered_report ?? result.report;
        if (report) { outputSync({ ok: true, command: "supervisor.watch", interval_ms: interval, ...result }); supervisor.acknowledgeReport(report.report_id); }
        return result;
      };
      const first = await cycle();
      if (values.once) return { ok: true, command: "supervisor.watch", interval_ms: interval, ...first };
      for (;;) { await new Promise<void>(resolve => setTimeout(resolve, interval)); await cycle(); }
    }
    if (command === "report" && subcommand === "ack" && argument) { supervisor.acknowledgeReport(argument); return { ok: true, command: "report.ack", report_id: argument }; }
    if (command === "report" && subcommand === "status") return { ok: true, command: "report.status", status: supervisor.status() };
    if (command === "gjc" && subcommand === "connect") {
      if (!argument) throw new JarvisError("GJC_CONFIG_INVALID"); const input = object(await jsonFile(argument)); const keys = Object.keys(input).sort(); if (keys.length !== 4 || keys.join(",") !== "cwd,profile,repo,session_id" || input.profile !== "jarvis" || input.repo !== "Orca-JARVIS" || typeof input.cwd !== "string" || typeof input.session_id !== "string") throw new JarvisError("GJC_CONFIG_INVALID");
      const root = realpathSync(input.cwd); const receipt = await gjc.call(root, { tool: "gjc_coordinator_register_session", arguments: { cwd: root, session_id: input.session_id }, mutation: true, allow_mutation: true, idempotency_key: `register:${input.session_id}` }); if (!gjc.lastServerInfo) throw new JarvisError("GJC_MCP_PROTOCOL"); const config = db.configureGjc(root, input.session_id, true, receipt, (dependencies.clock?.() ?? new Date()).toISOString(), gjc.lastServerInfo); return { ok: true, command: "gjc.connect", connected: true, receipt, ...config };
    }
    if (command === "gjc" && subcommand === "status") return { ok: true, command: "gjc.status", ...gjcService.status() };
    if (command === "gjc" && subcommand === "sync") { if (typeof values.idempotency_key !== "string" || typeof values.input !== "string") throw new JarvisError("GJC_SYNC_SCHEMA_INVALID"); const payload = object(await jsonFile(values.input)); const config = db.gjcConfig(); if (!config?.operational || payload.session_id !== config.session_id || typeof payload.turn_id !== "string" || !payload.turn_id || Object.keys(payload).sort().join(",") !== "session_id,turn_id") throw new JarvisError("GJC_SYNC_SCHEMA_INVALID"); return { ok: true, command: "gjc.sync", intent_id: db.createGjcIntent("sync", payload, values.idempotency_key) }; }
    if (command === "gjc" && subcommand === "dispatch" && argument) { const task = object(await jsonFile(argument)); return { ok: true, command: "gjc.dispatch", intent_id: db.createGjcDispatchFromTask(task, (dependencies.clock?.() ?? new Date()).toISOString()) }; }
    if (command === "gjc" && subcommand === "questions") return { ok: true, command: "gjc.questions", questions: db.db.prepare("SELECT question_id,intent_id,snapshot_json,state,created_at,answered_at FROM gjc_questions ORDER BY created_at,question_id").all() };
    if (command === "gjc" && subcommand === "answer" && argument) { const input = object(await jsonFile(argument)); const keys = Object.keys(input).sort(); if (keys.join(",") !== "answer,answer_binding,idempotency_key,question_id,session_id,turn_id" || typeof input.question_id !== "string" || typeof input.idempotency_key !== "string") throw new JarvisError("GJC_ANSWER_SCHEMA_INVALID"); const { question_id, idempotency_key, ...answer } = input; return { ok: true, command: "gjc.answer", question_id, intent_id: db.createGjcQuestionAnswerIntent(question_id, answer, idempotency_key, (dependencies.clock?.() ?? new Date()).toISOString()) }; }
    if (command === "gjc" && subcommand === "run" && values.once) return { ok: true, command: "gjc.run", ...(await gjcService.once((dependencies.clock?.() ?? new Date()).toISOString())) };
    if (command === "service" && subcommand === "status") return { ok: true, command: "service.status", ...gjcService.status() };
    if (command === "service" && subcommand === "once") return { ok: true, command: "service.once", ...(await gjcService.once((dependencies.clock?.() ?? new Date()).toISOString())) };
    if (command === "service" && subcommand === "run") { const raw = values["interval-ms"] ?? values.interval_ms; const interval = raw === undefined ? 10_000 : integer(String(raw)); if (interval < 1 || interval > 60_000) throw new JarvisError("GJC_INTERVAL_INVALID"); if (values.once) return { ok: true, command: "service.run", interval_ms: interval, ...(await gjcService.once((dependencies.clock?.() ?? new Date()).toISOString())) }; await gjcService.run(interval); return { ok: true, command: "service.run", interval_ms: interval }; }
    if (command === "approval" && subcommand === "ingest" && argument) return { ok: true, command: "approval.ingest", intent_id: shadow.recordAuthorityReceipt(object(await jsonFile(argument)) as unknown as AuthorityReceipt) ?? null, dispatched: false };
    if (preGjc === "keys" && preSubcommand === "register" && preArgument) { shadow.registerKey(object(await jsonFile(preArgument)) as unknown as ShadowKey); return { ok: true, command: "pre-gjc.keys.register" }; }
    if (preGjc === "keys" && preSubcommand === "revoke" && preArgument) { const input = object(await jsonFile(preArgument)); shadow.revokeKey(String(input.key_id ?? ""), input.provider as "codex" | "claude", input.purpose as "progress-signal" | "authority-receipt" | "verification" | "census", String(input.reason ?? "")); return { ok: true, command: "pre-gjc.keys.revoke" }; }
    if (preGjc === "projects" && preSubcommand === "configure" && preArgument) { const input = object(await jsonFile(preArgument)); shadow.configureProject(String(input.project_id ?? ""), input.provider as "codex" | "claude", Number(input.token_budget), Number(input.cache_budget), input.max_attempts === undefined ? undefined : Number(input.max_attempts)); return { ok: true, command: "pre-gjc.projects.configure" }; }
    if (preGjc === "projects" && (preSubcommand === "pause" || preSubcommand === "resume") && preArgument) { shadow.setPaused(preArgument, preSubcommand === "pause"); return { ok: true, command: `pre-gjc.projects.${preSubcommand}`, project_id: preArgument }; }
    if (preGjc === "projects" && preSubcommand === "status") return { ok: true, command: "pre-gjc.projects.status", status: shadow.status() };
    if (preGjc === "candidates" && preSubcommand === "ingest" && preArgument && preFourth) { const envelope = object(await jsonFile(preFourth)); const provider = object(envelope.progress_signal).provider; const signal = provider === "codex" ? ingestCodexAppServerEvent(envelope) : provider === "claude" ? ingestClaudeHookEvent(envelope) : (() => { throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID"); })(); let worktree = preArgument; try { worktree = realpathSync(preArgument); } catch { /* non-filesystem selectors remain explicit test/shadow inputs */ } const result = shadow.enqueueCandidate(worktree, signal); return { ok: true, command: "pre-gjc.candidates.ingest", ...result }; }
    if (preGjc === "candidates" && preSubcommand === "process" && preArgument && preFourth) { const claim = shadow.claimNext(preArgument); if (!claim) return { ok: true, command: "pre-gjc.candidates.process", claim: null }; return { ok: true, command: "pre-gjc.candidates.process", claim, ...shadow.stageCandidate(claim, preFourth) }; }
    if (preGjc === "candidates" && preSubcommand === "recover") return { ok: true, command: "pre-gjc.candidates.recover", recovered: shadow.recoverCandidates() };
    if (preGjc === "authority" && preSubcommand === "list") return { ok: true, command: "pre-gjc.authority.list", requests: shadow.listAuthority() };
    if (preGjc === "authority" && preSubcommand === "request" && preArgument) return { ok: true, command: "pre-gjc.authority.request", request_id: shadow.requestAuthority(object(await jsonFile(preArgument)) as unknown as AuthorityRequest) };
    if (preGjc === "authority" && preSubcommand === "consume" && preArgument) return { ok: true, command: "pre-gjc.authority.consume", intent_id: shadow.recordAuthorityReceipt(object(await jsonFile(preArgument)) as unknown as AuthorityReceipt), dispatched: false };
    if (preGjc === "reports" && preSubcommand === "pending") return { ok: true, command: "pre-gjc.reports.pending", reports: shadow.pendingReports() };
    if (preGjc === "reports" && preSubcommand === "claim" && preArgument) return { ok: true, command: "pre-gjc.reports.claim", report: shadow.claimReport(preArgument) ?? null };
    if (preGjc === "reports" && preSubcommand === "ack" && preArgument && preFourth && preFifth) { shadow.acknowledgeReport({ report_id: preArgument, fence: integer(preFourth) }, await jsonFile(preFifth)); return { ok: true, command: "pre-gjc.reports.ack", report_id: preArgument }; }
    if (preGjc === "evidence" && preSubcommand === "record" && preArgument) { const input = object(await jsonFile(preArgument)); const kind = input.kind; if (kind !== "focused" && kind !== "integration" && kind !== "crash_replay" && kind !== "cli" && kind !== "full" && kind !== "node24") throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID"); return { ok: true, command: "pre-gjc.evidence.record", evidence_id: shadow.recordCompletionEvidence(String(input.project_id ?? ""), kind, input.payload, new Date()) }; }
    if (preGjc === "census" && preSubcommand === "record" && preArgument) { const input = object(await jsonFile(preArgument)); return { ok: true, command: "pre-gjc.census.record", evidence_id: shadow.recordCensus(String(input.project_id ?? ""), input.payload, new Date()) }; }
    if (preGjc === "proposal" && preSubcommand === "list") return { ok: true, command: "pre-gjc.proposal.list", proposals: shadow.listProposals() };
    if (command === "pre-gjc" && subcommand === "status") return { ok: true, command: "pre-gjc.status", status: shadow.status() };
    if (command === "observe" && subcommand === "orca") {
      let bindings: ReturnType<typeof parseOrcaBindings> | undefined;
      if (typeof values.bindings === "string") { try { bindings = parseOrcaBindings(JSON.parse(await readFile(values.bindings, "utf8"))); } catch (error) { if (error instanceof JarvisError) throw error; throw new JarvisError("ORCA_BINDINGS_INVALID"); } }
      const limit = typeof values.limit === "string" ? Number(values.limit) : undefined; const maxPages = typeof values.max_pages === "string" ? Number(values.max_pages) : undefined;
      return { ok: true, command: "observe.orca", ...(await observeOrca(db, { worktree: typeof values.worktree === "string" ? values.worktree : undefined, bindings, limit, maxPages, runner: dependencies.orcaRunner })) };
    }
    if (command === "census" && subcommand === "ingest" && argument) return { ok: true, ...db.ingest(JSON.parse(await readFile(argument, "utf8")), await keyFor(db, policyKeyPath)) };
    if (command === "census" && subcommand === "resolve" && argument && fourth) { db.recordResolution(argument, JSON.parse(await readFile(fourth, "utf8"))); return { ok: true, work_id: argument, resolution: "recorded" }; }
    if (command === "work" && subcommand === "verify-record" && argument) { db.recordVerification(JSON.parse(await readFile(argument, "utf8"))); return { ok: true, verification: "recorded" }; }
    if (command === "status" && values.json) return { ok: true, ...db.status() };
    if (command === "approval" && subcommand === "list") return { ok: true, approvals: db.listApprovals(), authority_requests: shadow.listAuthority(), gjc_questions: db.db.prepare("SELECT question_id,intent_id,snapshot_json,state,created_at,answered_at FROM gjc_questions WHERE state='open' ORDER BY created_at,question_id").all() };
    if (command === "approval" && subcommand === "approve" && argument && fourth) { const continuation = db.approveWithReceipt(argument, JSON.parse(await readFile(fourth, "utf8"))); return { ok: true, work_id: argument, ...continuation }; }
    if (command === "approval" && subcommand === "reject" && argument && fourth) { db.rejectWithReceipt(argument, JSON.parse(await readFile(fourth, "utf8"))); return { ok: true, work_id: argument, decision: "rejected" }; }
    if (command === "resume" && subcommand === "deliver" && argument) { if (!supervisor.pendingLiveResumeIntents().includes(argument)) throw new JarvisError("ORCA_RESUME_DISABLED"); shadow.deliverResume(argument, new OrcaTerminalResumeAdapter(db, true, dependencies.liveOrcaCommand, dependencies.clock), dependencies.clock?.() ?? new Date()); return { ok: true, command: "resume.deliver", intent_id: argument, dispatched: true }; }
    if (command === "capabilities" && values.json) { const liveResume = supervisor.liveResumeConfigured(); const gjcEnabled = db.gjcOperational(); return { ok: true, supported_targets: ["codex", "claude"], providers: ["codex", "claude"], orca_read: true, codex_observe: true, claude_observe: true, pre_gjc_shadow: true, pre_gjc_signed_signals: true, pre_gjc_durable_state: true, pre_gjc_authority_resume: true, authority_resume_intents: true, live_resume: liveResume, pre_gjc_completion_promotion: true, pre_gjc_proposal_only: true, gjc: gjcEnabled, live_seed: false, live_dispatch: gjcEnabled, arbitrary_verify_execution: false, self_modify: false, shadow_only: !liveResume && !gjcEnabled }; }
    if (command === "worker" && subcommand === "run" && values.once) return { ok: true, ...db.workerOnce(values.crash as "before_commit" | "after_commit" | "ambiguous" | undefined) };
    throw new JarvisError("UNKNOWN_COMMAND");
  } finally { db.close(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) execute(process.argv.slice(2)).then(output).catch((error: unknown) => { const e = error instanceof JarvisError ? error : new JarvisError("INTERNAL_ERROR", error instanceof Error ? error.message : "unknown"); process.stderr.write(`${JSON.stringify({ version: 1, ok: false, error: { code: e.code, message: e.message } })}\n`); process.exitCode = 2; });
