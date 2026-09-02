import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityDb, GjcRuntimeService, JarvisError } from "../../src/index.js";
import { GjcCoordinatorClient } from "../../src/gjc.js";
import { type OrcaRunner } from "../../src/orca.js";
import { execute } from "../../src/cli.js";
import { decisionReceiptFor, initialized, policyKey, snapshot, tempDb } from "../helpers.js";

describe("GJC runtime", () => {
  it("keeps the dispatch loop idle when GJC is not operational", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const service = new GjcRuntimeService(
      db,
      new GjcCoordinatorClient(async () => {
        throw new Error("coordinator must not be called");
      }),
      "idle-disconnected",
    );
    await expect(service.once("2026-08-10T00:00:00.000Z")).resolves.toMatchObject({
      connected: false,
      processed: null,
      state: "disconnected",
    });
  });

  it("rejects legacy flat read and answer response fixtures without settling success", async () => {
    const envelope = (body: unknown) => ({ stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(body) }] } })}\n`, exitCode: 0 });
    const db = new AuthorityDb(tempDb()); await db.migrate(); db.configureGjc(process.cwd(), "s", true); const sync = db.createGjcIntent("sync", { session_id: "s", turn_id: "t" }, "flat-read"); const read = new GjcRuntimeService(db, new GjcCoordinatorClient(async () => envelope({ status: "completed", session_id: "s", turn_id: "t" })), "flat-read", undefined, () => new Date("2026-08-10T00:00:00.000Z")); await expect(read.once("2026-08-10T00:00:00.000Z")).resolves.toMatchObject({ state: "uncertain" }); expect((db.db.prepare("SELECT state FROM gjc_intents WHERE intent_id=?").get(sync) as { state: string }).state).toBe("uncertain");
    db.bindGjcQuestion(sync, "q", { session_id: "s", turn_id: "t", question_id: "q" }); const answer = db.createGjcQuestionAnswerIntent("q", { session_id: "s", turn_id: "t", answer_binding: { key: "v" }, answer: "yes" }, "flat-answer"); const submit = new GjcRuntimeService(db, new GjcCoordinatorClient(async () => envelope({ status: "completed", session_id: "s", turn_id: "t", question_id: "q", answer: "yes" }), true), "flat-answer", undefined, () => new Date("2026-08-10T00:02:00.000Z")); await expect(submit.once("2026-08-10T00:02:00.000Z")).resolves.toMatchObject({ state: "uncertain" }); expect((db.db.prepare("SELECT state FROM gjc_intents WHERE intent_id=?").get(answer) as { state: string }).state).toBe("uncertain"); expect((db.db.prepare("SELECT COUNT(*) AS n FROM gjc_answer_receipts").get() as { n: number }).n).toBe(0);
  });
  it("drives read_turn then await_turn for every nonterminal structured lifecycle status", async () => {
    for (const status of ["queued", "delivering", "active", "waiting_for_answer", "completing"]) { const db = new AuthorityDb(tempDb()); await db.migrate(); db.configureGjc(process.cwd(), "s", true); db.createGjcIntent("sync", { session_id: "s", turn_id: "t" }, `read-${status}`); const calls: string[] = []; const reply = (body: unknown) => ({ stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(body) }] } })}\n`, exitCode: 0 }); const client = new GjcCoordinatorClient(async run => { const name = JSON.parse(run.stdin.trim().split("\n")[2]!).params.name; calls.push(name); return name === "gjc_coordinator_read_turn" ? reply({ ok: true, turn: { status, turn_id: "t", session_id: "s" } }) : name === "gjc_coordinator_await_turn" ? reply({ ok: true, turn: { status: "completed", turn_id: "t", session_id: "s" } }) : reply({ questions: [] }); }); const service = new GjcRuntimeService(db, client, status, undefined, () => new Date("2026-08-10T00:00:00.000Z")); await expect(service.once("2026-08-10T00:00:00.000Z")).resolves.toMatchObject({ state: "completed" }); expect(calls).toEqual(["gjc_coordinator_read_turn", "gjc_coordinator_await_turn", "gjc_coordinator_list_questions"]); }
  });
  it("human-approved GJC work never ACKs mocks before turn completion, then ACKs once after durable sync completion", async () => {
    const db = await initialized(); db.configureGjc(process.cwd(), "s", true); db.ingest(snapshot("codex", { authorization: "both" }), policyKey(db)); db.approveWithReceipt("codex-work", decisionReceiptFor(db, "codex-work")); const before = db.workerOnce(); expect(before).toMatchObject({ processed: 0, outcome: "GJC_PENDING" }); expect((db.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE acked_at IS NOT NULL").get() as { n: number }).n).toBe(0);
    const dispatch = db.db.prepare("SELECT intent_id FROM gjc_intents WHERE kind='dispatch'").get() as { intent_id: string }; const claim = db.claimGjcIntent(dispatch.intent_id, "test", new Date().toISOString())!; db.settleGjcIntent(dispatch.intent_id, Number(claim.lease_fence), { status: "accepted", receipt: { status: "accepted", session_id: "s", turn_id: "t" } }); const sync = db.db.prepare("SELECT intent_id FROM gjc_intents WHERE kind='sync'").get() as { intent_id: string }; const syncClaim = db.claimGjcIntent(sync.intent_id, "test", new Date().toISOString())!; db.settleGjcIntent(sync.intent_id, Number(syncClaim.lease_fence), { status: "completed", receipt: { status: "completed", turn_id: "t" } }); expect(db.workerOnce()).toMatchObject({ processed: 1 }); expect(db.workerOnce()).toMatchObject({ processed: 1 }); expect(db.workerOnce()).toMatchObject({ processed: 0 }); expect((db.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE acked_at IS NOT NULL").get() as { n: number }).n).toBe(2);
  });
  it("policy-only shadow work never creates an external GJC dispatch when disconnected", async () => {
    const db = await initialized(); db.ingest(snapshot("codex", { authorization: "code" }), policyKey(db));
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM gjc_intents WHERE kind='dispatch'").get() as { n: number }).n).toBe(0);
    expect(db.workerOnce()).toMatchObject({ processed: 1 }); expect(db.workerOnce()).toMatchObject({ processed: 1 });
  });
  it("durably dispatches GJC-connected policy work with its policy continuation binding", async () => {
    const db = await initialized(); db.configureGjc(process.cwd(), "policy-session", true); db.ingest(snapshot("codex", { authorization: "code" }), policyKey(db));
    const continuation = db.db.prepare("SELECT id FROM continuation_acceptances WHERE work_id='codex-work' AND authorization_kind='policy'").get() as { id: string };
    const dispatches = db.db.prepare("SELECT continuation_id,kind,state,payload_json FROM gjc_intents WHERE kind='dispatch'").all() as Array<{ continuation_id: string; kind: string; state: string; payload_json: string }>;
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ continuation_id: continuation.id, kind: "dispatch", state: "pending" });
    expect(JSON.parse(dispatches[0]!.payload_json)).toMatchObject({ continuation_id: continuation.id, session_id: "policy-session" }); db.close();
  });
  it("reconciles only structured terminal coordinator states and never creates a mock acknowledgement", async () => {
    const nonterminal = ["queued", "delivering", "active", "waiting_for_answer", "completing"]; const terminal = ["failed", "cancelled", "superseded"];
    for (const status of [...nonterminal, ...terminal]) { const db = new AuthorityDb(tempDb()); await db.migrate(); db.configureGjc(process.cwd(), "s", true); const intent = db.createGjcIntent("dispatch", { cwd: process.cwd(), session_id: "s", prompt: status }, `state-${status}`); const reply = (value: unknown) => ({ stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(value) }] } })}\n`, exitCode: 0 }); const client = new GjcCoordinatorClient(async () => reply({ ok: true, turn: { status, turn_id: "t", session_id: "s" } }), true); const service = new GjcRuntimeService(db, client, `worker-${status}`, undefined, () => new Date("2026-08-10T00:00:00.000Z")); const outcome = await service.once("2026-08-10T00:00:00.000Z"); expect(outcome.processed).toBe(intent); expect(outcome.state).toBe(terminal.includes(status) ? "failed" : "uncertain"); expect((db.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n).toBe(0); }
  });
  it("exposes CLI service status and once lifecycle without a live Orca binding", async () => { const root = mkdtempSync(`${tmpdir()}/gjc-service-`); const db = join(root, "db.sqlite"); await execute(["db", "migrate", "--db", db]); await expect(execute(["service", "status", "--db", db])).resolves.toMatchObject({ command: "service.status", connected: false }); });
  it("service run consumes one recovered live supervisor report and resumes observation", async () => {
    const root = mkdtempSync(`${tmpdir()}/gjc-live-service-`); const worktree = join(root, "worktree"); mkdirSync(worktree); const db = join(root, "authority.sqlite"); const binding = join(root, "binding.json"); writeFileSync(binding, JSON.stringify({ worktree, provider: "codex", terminal_id: "terminal", session_id: "session", incarnation_id: "incarnation", pty_id: "pty", worktree_id: "worktree", project_id: "project" }));
    const terminalList = JSON.stringify({ ok: true, result: { terminals: [{ handle: "terminal", ptyId: "pty", incarnationId: "incarnation", worktreeId: "worktree", worktreePath: null, title: "Codex", connected: true, writable: true, lastOutputAt: null, preview: null }] } }); let cursor = "cursor-1"; let reads = 0;
    const runner = async (args: readonly string[]) => { if (args[1] === "list") return terminalList; reads++; return JSON.stringify({ ok: true, result: { terminal: { handle: "terminal", status: "ok", tail: [], truncated: false, limited: false, oldestCursor: null, nextCursor: cursor, latestCursor: cursor, returnedLineCount: 0 } } }); };
    try {
      await execute(["db", "migrate", "--db", db]); const direct = new AuthorityDb(db); direct.configureGjc(root, "s", true); direct.close(); await execute(["project", "register", binding, "--db", db]);
      const first = await execute(["supervisor", "once", "--db", db], { orcaRunner: runner }); const report = first.report as { report_id: string }; expect(report.report_id).toMatch(/^live_report_/); expect(reads).toBe(1); expect((await execute(["report", "status", "--db", db])).status).toMatchObject({ reports_pending: 1, reports_delivered: 0 });
      const emitted: Record<string, unknown>[] = []; const liveReportOutput = (value: object) => { const item = value as Record<string, unknown>; emitted.push(item); const outputReport = item.recovered_report as { report_id: string } | null; expect(outputReport?.report_id).toBe(report.report_id); const atOutput = new AuthorityDb(db); try { expect(Number((atOutput.db.prepare("SELECT COUNT(*) AS n FROM live_supervisor_report_receipts WHERE report_id=?").get(report.report_id) as { n: number }).n)).toBe(0); } finally { atOutput.close(); } };
      await execute(["service", "run", "--once", "--interval-ms", "1", "--db", db], { orcaRunner: async () => { throw new Error("must not observe while replaying recovered report"); }, liveReportOutput });
      expect(emitted).toHaveLength(1); expect(emitted[0]?.command).toBe("service.run"); expect(emitted[0]?.interval_ms).toBe(1); expect((emitted[0]?.recovered_report as { report_id: string } | undefined)?.report_id).toBe(report.report_id); const acked = new AuthorityDb(db); expect(Number((acked.db.prepare("SELECT COUNT(*) AS n FROM live_supervisor_report_receipts WHERE report_id=?").get(report.report_id) as { n: number }).n)).toBe(1); acked.close(); expect((await execute(["report", "status", "--db", db])).status).toMatchObject({ reports_pending: 0, reports_delivered: 1 });
      cursor = "cursor-2"; await execute(["service", "run", "--once", "--interval-ms", "1", "--db", db], { orcaRunner: runner }); const final = new AuthorityDb(db); expect(Number((final.db.prepare("SELECT COUNT(*) AS n FROM live_supervisor_report_receipts WHERE report_id=?").get(report.report_id) as { n: number }).n)).toBe(1); final.close(); expect(reads).toBe(2); expect((await execute(["report", "status", "--db", db])).status).toMatchObject({ reports_pending: 0, reports_delivered: 2 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("turn receipt creates one bound reconciliation intent which reaches completed without mock acknowledgement", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate(); db.configureGjc(process.cwd(), "s", true); const dispatch = db.createGjcIntent("dispatch", { cwd: process.cwd(), session_id: "s", prompt: "bounded" }, "dispatch"); const claim = db.claimGjcIntent(dispatch, "worker", "2026-08-10T00:00:00.000Z")!; db.settleGjcIntent(dispatch, Number(claim.lease_fence), { status: "accepted", receipt: { status: "accepted", session_id: "s", turn_id: "t" } }, "2026-08-10T00:00:01.000Z"); const sync = db.db.prepare("SELECT intent_id,payload_json,state FROM gjc_intents WHERE kind='sync'").get() as { intent_id: string; payload_json: string; state: string }; expect(JSON.parse(sync.payload_json)).toEqual({ session_id: "s", turn_id: "t" }); expect(sync.state).toBe("pending"); expect((db.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n).toBe(0);
    const reply = (value: unknown) => ({ stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(value) }] } })}\n`, exitCode: 0 }); const client = new GjcCoordinatorClient(async run => JSON.parse(run.stdin.trim().split("\n")[2]!).params.name === "gjc_coordinator_read_turn" ? reply({ ok: true, turn: { status: "completed", turn_id: "t", session_id: "s" } }) : reply({ questions: [] })); const service = new GjcRuntimeService(db, client, "worker", undefined, () => new Date("2026-08-10T00:00:02.000Z")); await expect(service.once("2026-08-10T00:00:02.000Z")).resolves.toMatchObject({ processed: sync.intent_id, state: "completed" }); expect((db.db.prepare("SELECT state FROM gjc_intents WHERE intent_id=?").get(sync.intent_id) as { state: string }).state).toBe("completed");
  });
  it("fence loss after a coordinator response prevents normal settlement", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate(); db.configureGjc(process.cwd(), "s", true); const intent = db.createGjcIntent("sync", { session_id: "s", turn_id: "t" }, "fence-loss"); const response = (value: unknown) => ({ stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(value) }] } })}\n`, exitCode: 0 }); const client = new GjcCoordinatorClient(async () => { db.db.prepare("UPDATE gjc_runtime_leases SET fence=fence+1 WHERE id=1").run(); return response({ status: "completed", turn_id: "t" }); }); const service = new GjcRuntimeService(db, client, "worker", undefined, () => new Date("2026-08-10T00:00:00.000Z")); await expect(service.once("2026-08-10T00:00:00.000Z")).rejects.toMatchObject({ code: "GJC_STALE_LEASE" }); expect((db.db.prepare("SELECT state FROM gjc_intents WHERE intent_id=?").get(intent) as { state: string }).state).toBe("claimed");
  });
  it("CLI connect registers an exact config through the injected coordinator runner", async () => {
    const root = mkdtempSync(`${tmpdir()}/gjc-cli-`); const db = join(root, "db.sqlite"); const config = join(root, "gjc.json"); writeFileSync(config, JSON.stringify({ cwd: root, session_id: "s-1", profile: "jarvis", repo: "Orca-JARVIS" })); await execute(["db", "migrate", "--db", db]); let request: Record<string, unknown> | undefined;
    const runner = async (run: { stdin: string }) => { request = JSON.parse(run.stdin.trim().split("\n")[2]!) as Record<string, unknown>; return { stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ session_id: "s-1", status: "accepted" }) }] } })}\n`, exitCode: 0 }; };
    await expect(execute(["gjc", "connect", config, "--db", db], { gjcRunner: runner })).resolves.toMatchObject({ command: "gjc.connect", connected: true }); expect(request).toMatchObject({ params: { name: "gjc_coordinator_register_session", arguments: { session_id: "s-1", allow_mutation: true, idempotency_key: "register:s-1" } } }); expect((request?.params as { arguments: Record<string, unknown> }).arguments.profile).toBeUndefined(); const opened = new AuthorityDb(db); opened.createGjcIntent("sync", { session_id: "s-1", turn_id: "t" }, "cli-sync"); opened.close(); const lifecycle = async (run: { stdin: string }) => { const name = JSON.parse(run.stdin.trim().split("\n")[2]!).params.name; return { stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(name === "gjc_coordinator_read_turn" ? { ok: true, turn: { status: "completed", turn_id: "t", session_id: "s-1" } } : { questions: [] }) }] } })}\n`, exitCode: 0 }; }; await expect(execute(["service", "once", "--db", db], { gjcRunner: lifecycle })).resolves.toMatchObject({ command: "service.once", state: "completed" }); await expect(execute(["service", "run", "--once", "--interval-ms", "1", "--db", db], { gjcRunner: lifecycle })).resolves.toMatchObject({ command: "service.run", interval_ms: 1 });
  });
  it("binds exact config, keeps unauthorised dispatch at zero, and never replays uncertainty", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate(); expect(() => db.createGjcIntent("dispatch", {}, "k")).toThrow("GJC_NOT_CONNECTED");
    db.configureGjc(process.cwd(), "session", true, "2026-08-10T00:00:00.000Z"); const id = db.createGjcIntent("dispatch", { x: 1 }, "stable", undefined, "2026-08-10T00:00:01.000Z"); expect(db.createGjcIntent("dispatch", { x: 1 }, "stable")).toBe(id);
    const client = new GjcCoordinatorClient(async () => ({ stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ status: "mystery" }) }] } })}\n`, exitCode: 0 })); const service = new GjcRuntimeService(db, client, "gjc-runtime", undefined, () => new Date("2026-08-10T00:00:02.000Z")); await expect(service.once("2026-08-10T00:00:02.000Z")).resolves.toMatchObject({ state: "uncertain" }); expect(await service.once("2026-08-10T00:00:03.000Z")).toEqual({ processed: null, state: null });
  });
  it("rejects conflicting question-answer replays", async () => { const db = new AuthorityDb(tempDb()); await db.migrate(); db.configureGjc(process.cwd(), "s", true); const intent = db.createGjcIntent("sync", { session_id: "s", turn_id: "t" }, "sync"); db.bindGjcQuestion(intent, "q", { prompt: "ok" }); db.answerGjcQuestion("q", { answer: "yes" }, "a"); expect(() => db.answerGjcQuestion("q", { answer: "no" }, "a")).toThrow("GJC_ANSWER_REPLAY_CONFLICT"); });
  it("queues only schema-bound question submissions and rejects missing or mismatched bindings", async () => { const db = new AuthorityDb(tempDb()); await db.migrate(); db.configureGjc(process.cwd(), "s", true); const intent = db.createGjcIntent("sync", { session_id: "s", turn_id: "t" }, "sync"); db.bindGjcQuestion(intent, "q", { session_id: "s", turn_id: "t", question_id: "q", prompt: "ok" }); expect(db.createGjcQuestionAnswerIntent("q", { session_id: "s", turn_id: "t", answer_binding: { choice: "a" }, answer: "yes" }, "answer-1")).toMatch(/^gjc_/); expect(() => db.createGjcQuestionAnswerIntent("q", { session_id: "s", turn_id: "wrong", answer_binding: {}, answer: "yes" }, "answer-2")).toThrow("GJC_QUESTION_BINDING_CONFLICT"); expect(() => db.createGjcQuestionAnswerIntent("q", { session_id: "s", turn_id: "t", answer: "yes" }, "answer-3")).toThrow("GJC_ANSWER_SCHEMA_INVALID"); });
  it("projects a stale persisted live binding as unknown when its Orca terminal list fails", async () => {
    const root = mkdtempSync(`${tmpdir()}/gjc-stale-selector-`); const worktree = join(root, "worktree"); mkdirSync(worktree); const db = join(root, "authority.sqlite"); const binding = join(root, "binding.json"); writeFileSync(binding, JSON.stringify({ worktree, provider: "codex", terminal_id: "terminal", session_id: "session", incarnation_id: "incarnation", pty_id: "pty", worktree_id: "worktree", project_id: "project" }));
    const runner: OrcaRunner = async args => {
      if (args[0] === "terminal" && args[1] === "list") throw new JarvisError("ORCA_CLI_FAILED");
      throw new JarvisError("ORCA_CLI_FAILED");
    };
    try {
      await execute(["db", "migrate", "--db", db]); const direct = new AuthorityDb(db); direct.configureGjc(root, "s", true); direct.close();
      await execute(["project", "register", binding, "--db", db]);
      const result = await execute(["service", "once", "--db", db], { orcaRunner: runner });
      expect(result).toMatchObject({ command: "service.once", state: null });
      const opened = new AuthorityDb(db);
      try {
        const row = opened.db.prepare("SELECT projection_state FROM live_supervisor_cursors WHERE canonical_path=? AND provider=? AND terminal_id=?").get(realpathSync(worktree), "codex", "terminal") as { projection_state: string } | undefined;
        expect(row?.projection_state).toBe("unknown");
      } finally { opened.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("does not swallow schema or binding failures while observing a persisted binding", async () => {
    const root = mkdtempSync(`${tmpdir()}/gjc-schema-closed-`); const worktree = join(root, "worktree"); mkdirSync(worktree); const db = join(root, "authority.sqlite"); const binding = join(root, "binding.json"); writeFileSync(binding, JSON.stringify({ worktree, provider: "codex", terminal_id: "terminal", session_id: "session", incarnation_id: "incarnation", pty_id: "pty", worktree_id: "worktree", project_id: "project" }));
    const schemaRunner: OrcaRunner = async args => {
      if (args[0] === "terminal" && args[1] === "list") return JSON.stringify({ ok: true, version: 2, result: { terminals: [] } });
      throw new JarvisError("ORCA_CLI_FAILED");
    };
    try {
      await execute(["db", "migrate", "--db", db]); const direct = new AuthorityDb(db); direct.configureGjc(root, "s", true); direct.close();
      await execute(["project", "register", binding, "--db", db]);
      await expect(execute(["service", "once", "--db", db], { orcaRunner: schemaRunner })).rejects.toMatchObject({ code: "ORCA_CLI_SCHEMA_INVALID" });
      const bindingRunner: OrcaRunner = async args => {
        if (args[0] === "terminal" && args[1] === "list") throw new JarvisError("ORCA_PANE_BINDING_INVALID");
        throw new JarvisError("ORCA_CLI_FAILED");
      };
      await expect(execute(["service", "once", "--db", db], { orcaRunner: bindingRunner })).rejects.toMatchObject({ code: "ORCA_PANE_BINDING_INVALID" });
      // A plain runner exception becomes ORCA_CLI_FAILED at the adapter boundary:
      // it is the expected "cannot read Orca right now" failure and is tolerated.
      const opaqueRunner: OrcaRunner = async () => { throw new Error("boom"); };
      await expect(execute(["service", "once", "--db", db], { orcaRunner: opaqueRunner })).resolves.toMatchObject({ command: "service.once", state: null });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("does not replay a lost acknowledgement and fences a second runtime service", async () => { const db = new AuthorityDb(tempDb()); await db.migrate(); db.configureGjc(process.cwd(), "s", true); db.createGjcIntent("sync", { session_id: "s", turn_id: "t" }, "lost-ack"); let calls = 0; const failing = new GjcCoordinatorClient(async () => { calls++; throw new Error("lost ack"); }); const first = new GjcRuntimeService(db, failing, "one", undefined, () => new Date("2026-08-10T00:00:00.000Z")); await expect(first.once("2026-08-10T00:00:00.000Z")).resolves.toMatchObject({ state: "uncertain" }); await expect(first.once("2026-08-10T00:00:01.000Z")).resolves.toEqual({ processed: null, state: null }); expect(calls).toBe(1); db.createGjcIntent("sync", { session_id: "s", turn_id: "t2" }, "leased"); const second = new GjcRuntimeService(db, failing, "two"); await expect(second.once("2026-08-10T00:00:30.000Z")).resolves.toEqual({ processed: null, state: "leased" }); expect(calls).toBe(1); });
});
