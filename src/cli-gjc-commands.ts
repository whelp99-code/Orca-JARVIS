import { realpathSync, writeSync } from "node:fs";
import { type CliCommandContext, commandNow } from "./cli-command-context.js";
import { integer, jsonFile, objectValue } from "./cli-command-input.js";
import { observePersistedBinding } from "./persisted-orca-observer.js";
import { JarvisError } from "./db.js";
import { GjcCoordinatorClient } from "./gjc.js";
import { LiveSupervisor, type LiveSupervisorCycle } from "./live-supervisor.js";
import { PreGjcShadow } from "./pre-gjc-shadow.js";
import { PERSONAL_OS_CONTROL_CHANNEL_ENV, servePersonalOsCycleChannel } from "./personal-os-cycle-channel.js";
import { PersonalOsRuntime } from "./personal-os-runtime.js";
import { AssembledModelSession } from "./assembled-model-session.js";
import { RecordingModelTransport } from "./context-model-transport.js";
import type { ContextPersistenceInput } from "./personal-context-store.js";

function outputSync(value: object): void {
  writeSync(process.stdout.fd, `${JSON.stringify({ version: 1, ...value })}\n`);
}

export async function executeGjcCommand(
  context: CliCommandContext,
): Promise<Record<string, unknown> | undefined> {
  const { command, subcommand, argument, values, db, dependencies } = context;
  if (command !== "gjc" && command !== "service") return undefined;
  const gjc = new GjcCoordinatorClient(dependencies.gjcRunner, true);
  const shadow = new PreGjcShadow(db);
  const supervisor = new LiveSupervisor(db);
  let serviceRunInterval: number | undefined;
  const { service } = PersonalOsRuntime.forServiceRun({
    authority: db,
    coordinator: gjc,
    worker: "gjc-runtime",
    clock: () => commandNow(context),
    supervisorCycle: async () => {
      try {
        const result = await supervisor.cycleWithShadow(
          shadow,
          binding => observePersistedBinding(db, binding, dependencies.orcaRunner, () => commandNow(context)),
          commandNow(context).toISOString(),
        );
        deliverReport({ context, supervisor, result, interval: serviceRunInterval });
      } catch (error) {
        if (!(error instanceof JarvisError) || error.code !== "LIVE_WORKTREE_UNREGISTERED") throw error;
      }
    },
  });
  try {
    if (command === "gjc" && subcommand === "connect") {
      if (!argument) throw new JarvisError("GJC_CONFIG_INVALID");
      const input = objectValue(await jsonFile(argument));
      const keys = Object.keys(input).sort();
      if (keys.length !== 4
        || keys.join(",") !== "cwd,profile,repo,session_id"
        || input.profile !== "jarvis"
        || input.repo !== "Orca-JARVIS"
        || typeof input.cwd !== "string"
        || typeof input.session_id !== "string") throw new JarvisError("GJC_CONFIG_INVALID");
      const root = realpathSync(input.cwd);
      const receipt = await gjc.call(root, {
        tool: "gjc_coordinator_register_session",
        arguments: { cwd: root, session_id: input.session_id },
        mutation: true,
        allow_mutation: true,
        idempotency_key: `register:${input.session_id}`,
      });
      if (!gjc.lastServerInfo) throw new JarvisError("GJC_MCP_PROTOCOL");
      const config = db.configureGjc(
        root,
        input.session_id,
        true,
        receipt,
        commandNow(context).toISOString(),
        gjc.lastServerInfo,
      );
      return { ok: true, command: "gjc.connect", connected: true, receipt, ...config };
    }
    if (command === "gjc" && subcommand === "status") return { ok: true, command: "gjc.status", ...service.status() };
    if (command === "gjc" && subcommand === "sync") {
      if (!values.idempotency_key || !values.input) throw new JarvisError("GJC_SYNC_SCHEMA_INVALID");
      const payload = objectValue(await jsonFile(values.input));
      const config = db.gjcConfig();
      if (!config?.operational
        || payload.session_id !== config.session_id
        || typeof payload.turn_id !== "string"
        || !payload.turn_id
        || Object.keys(payload).sort().join(",") !== "session_id,turn_id") {
        throw new JarvisError("GJC_SYNC_SCHEMA_INVALID");
      }
      return { ok: true, command: "gjc.sync", intent_id: db.createGjcIntent("sync", payload, values.idempotency_key) };
    }
    if (command === "gjc" && subcommand === "dispatch" && argument) {
      const envelope = objectValue(await jsonFile(argument));
      const parsed = parseDispatchEnvelope(envelope);
      const now = commandNow(context).toISOString();
      db.assertGjcDispatchTask(parsed.task, now);
      const existing = db.gjcIntentIdForKey(String(parsed.task.idempotency_key));
      if (existing !== undefined) {
        return { ok: true, command: "gjc.dispatch", intent_id: existing, duplicate: true };
      }
      const assembled = await assembleDispatchContext(context, parsed);
      const intent = db.createGjcDispatchFromTask(parsed.task, now);
      return {
        ok: true, command: "gjc.dispatch", intent_id: intent,
        ...(assembled === undefined ? {} : { model_request_bytes: assembled.capture.bytes, model_session_id: assembled.capture.session_id }),
      };
    }
    if (command === "gjc" && subcommand === "questions") {
      const questions = db.db
        .prepare("SELECT question_id,intent_id,snapshot_json,state,created_at,answered_at FROM gjc_questions ORDER BY created_at,question_id")
        .all();
      return { ok: true, command: "gjc.questions", questions };
    }
    if (command === "gjc" && subcommand === "answer" && argument) {
      const input = objectValue(await jsonFile(argument));
      const keys = Object.keys(input).sort();
      if (keys.join(",") !== "answer,answer_binding,idempotency_key,question_id,session_id,turn_id"
        || typeof input.question_id !== "string"
        || typeof input.idempotency_key !== "string") throw new JarvisError("GJC_ANSWER_SCHEMA_INVALID");
      const { question_id, idempotency_key, ...answer } = input;
      const intent = db.createGjcQuestionAnswerIntent(
        question_id,
        answer,
        idempotency_key,
        commandNow(context).toISOString(),
      );
      return { ok: true, command: "gjc.answer", question_id, intent_id: intent };
    }
    if (command === "gjc" && subcommand === "run" && values.once) {
      return { ok: true, command: "gjc.run", ...(await service.once(commandNow(context).toISOString())) };
    }
    if (command === "service" && subcommand === "status") {
      return { ok: true, command: "service.status", ...service.status() };
    }
    if (command === "service" && subcommand === "once") {
      return { ok: true, command: "service.once", ...(await service.once(commandNow(context).toISOString())) };
    }
    if (command === "service" && subcommand === "run") {
      const control = process.env[PERSONAL_OS_CONTROL_CHANNEL_ENV];
      if (control !== undefined && control.length > 0) {
        await servePersonalOsCycleChannel({ db: db.db, socketPath: control });
        return { ok: true, command: "service.run", runtime_surface: "staged-execstart" };
      }
      const raw = values["interval-ms"] ?? values.interval_ms;
      const interval = raw === undefined ? 10_000 : integer(raw);
      if (interval < 1 || interval > 60_000) throw new JarvisError("GJC_INTERVAL_INVALID");
      serviceRunInterval = interval;
      if (values.once) {
        return {
          ok: true,
          command: "service.run",
          interval_ms: interval,
          ...(await service.once(commandNow(context).toISOString())),
        };
      }
      await service.run(interval);
      return { ok: true, command: "service.run", interval_ms: interval };
    }
    return undefined;
  } finally {
    service.close();
  }
}

type ReportDelivery = {
  readonly context: CliCommandContext;
  readonly supervisor: LiveSupervisor;
  readonly result: LiveSupervisorCycle;
  readonly interval: number | undefined;
};

function deliverReport(input: ReportDelivery): void {
  const report = input.result.recovered_report ?? input.result.report;
  if (!report) return;
  const output = input.context.dependencies.liveReportOutput ?? outputSync;
  const command = input.context.command === "service" ? `service.${input.context.subcommand}` : "gjc.run";
  output({ ok: true, command, ...(input.interval === undefined ? {} : { interval_ms: input.interval }), ...input.result });
  input.supervisor.acknowledgeReport(report.report_id);
}

function parseDispatchEnvelope(raw: Record<string, unknown>): {
  task: Record<string, unknown>;
  assemble_context: unknown;
  memory_evidence: ContextPersistenceInput["memory_evidence"];
} {
  if (typeof raw.task === "object" && raw.task !== null && !Array.isArray(raw.task)) {
    const extra = Object.keys(raw).filter(key => key !== "task" && key !== "assemble_context" && key !== "memory_evidence");
    if (extra.length > 0) throw new JarvisError("GJC_DISPATCH_SCHEMA_INVALID");
    const evidence = Array.isArray(raw.memory_evidence)
      ? raw.memory_evidence as ContextPersistenceInput["memory_evidence"]
      : [];
    return { task: raw.task as Record<string, unknown>, assemble_context: raw.assemble_context, memory_evidence: evidence };
  }
  return { task: raw, assemble_context: undefined, memory_evidence: [] };
}

async function assembleDispatchContext(
  context: CliCommandContext,
  parsed: { assemble_context: unknown; memory_evidence: ContextPersistenceInput["memory_evidence"] },
) {
  if (parsed.assemble_context === undefined) return undefined;
  const options = context.dependencies.memoryReferenceOptions;
  if (options === undefined) throw new JarvisError("MEMORY_REFERENCE_OPTIONS_REQUIRED");
  const session = new AssembledModelSession(
    context.db,
    options.model_transport ?? new RecordingModelTransport(),
    at => { options.read_fence?.(at); options.status_fence?.(at); },
  );
  return session.deliver(parsed.assemble_context, parsed.memory_evidence, commandNow(context).toISOString());
}
