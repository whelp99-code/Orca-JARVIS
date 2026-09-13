import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { readProcessStdin } from "./cli-host-memory.js";
import { type CliCommandContext, commandNow } from "./cli-command-context.js";
import { integer, jsonFile, objectValue } from "./cli-command-input.js";
import { observePersistedBinding } from "./persisted-orca-observer.js";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { GjcCoordinatorClient } from "./gjc.js";
import { LiveSupervisor, type LiveSupervisorCycle } from "./live-supervisor.js";
import { PreGjcShadow } from "./pre-gjc-shadow.js";
import { PERSONAL_OS_CONTROL_CHANNEL_ENV, servePersonalOsCycleChannel } from "./personal-os-cycle-channel.js";
import { PersonalOsRuntime } from "./personal-os-runtime.js";
import { AssembledModelSession } from "./assembled-model-session.js";
import { RecordingModelTransport } from "./context-model-transport.js";
import { assemblePersonalContext, type MemoryEvidenceInput, type ModelRequestV1 } from "./context-assembler.js";
import { createProductionMemoryReadFence } from "./memory-read-fence-production.js";
import { createProductionMemoryReference } from "./memory-reference-production.js";
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
      preflightDispatchAssemble(context, parsed);
      const reservation = db.reserveGjcDispatchFromTask(parsed.task, now);
      if (!reservation.reserved) {
        const latestAttempt = db.latestGjcSendAttempt(reservation.intent_id, reservation.lease_fence);
        const unknownSend = (latestAttempt !== undefined && !latestAttempt.failed)
          || (latestAttempt === undefined && db.gjcIntentHasEvent(reservation.intent_id, "model_send_started"));
        if (unknownSend && !db.gjcIntentHasEvent(reservation.intent_id, "model_dispatched")) {
          const deliveryId = db.gjcSendDeliveryId(reservation.intent_id);
          const transport = context.dependencies.memoryReferenceOptions?.model_transport;
          const reconciled = deliveryId !== undefined && transport !== undefined && "reconcile" in transport
            ? await (transport as { reconcile?: (id: string) => Promise<{ accepted: boolean } | undefined> }).reconcile?.(deliveryId)
            : undefined;
          if (reconciled?.accepted === true) {
            db.recordGjcReconciledReceipt(reservation.intent_id, now);
            return { ok: true, command: "gjc.dispatch", intent_id: reservation.intent_id, recovered: "remote_accepted" };
          }
          return { ok: true, command: "gjc.dispatch", intent_id: reservation.intent_id, recovered: "unknown_accepted" };
        }
        return { ok: true, command: "gjc.dispatch", intent_id: reservation.intent_id, duplicate: true };
      }
      try {
        const assembled = await assembleDispatchContext(context, parsed, reservation);
        if (assembled !== undefined) db.recordGjcModelDispatched(reservation.intent_id, now, reservation.lease_fence);
        return {
          ok: true, command: "gjc.dispatch", intent_id: reservation.intent_id,
          ...(assembled === undefined ? {} : { model_request_bytes: assembled.capture.bytes, model_session_id: assembled.capture.session_id }),
        };
      } catch (error) {
        if (error instanceof JarvisError && error.code === "MODEL_TRANSPORT_UNAVAILABLE") {
          db.recordGjcSendFailed(reservation.intent_id, now, reservation.lease_fence);
        }
        db.markGjcIntentUncertain(reservation.intent_id, now);
        throw error;
      }
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

function dispatchMemoryAuthorizer(
  context: CliCommandContext,
  options: NonNullable<CliCommandContext["dependencies"]["memoryReferenceOptions"]>,
) {
  const configuredFence = options.read_fence_config === undefined
    ? undefined
    : createProductionMemoryReadFence(context.db, options.read_fence_config);
  const configuredStatus = options.read_fence_config === undefined
    ? undefined
    : createProductionMemoryReadFence(context.db, options.read_fence_config, "memory_status");
  return (at: Date) => {
    configuredFence?.(at);
    configuredStatus?.(at);
    options.read_fence?.(at);
    options.status_fence?.(at);
  };
}

function preflightDispatchAssemble(
  context: CliCommandContext,
  parsed: { assemble_context: unknown; memory_evidence: ContextPersistenceInput["memory_evidence"] },
): void {
  if (parsed.assemble_context === undefined) return;
  const options = context.dependencies.memoryReferenceOptions;
  if (options === undefined) throw new JarvisError("MEMORY_REFERENCE_OPTIONS_REQUIRED");
  dispatchMemoryAuthorizer(context, options)(commandNow(context));
}

function queryFromAssemble(input: unknown): string {
  return input !== null && typeof input === "object" && "query" in input && typeof input.query === "string"
    ? input.query : "what now?";
}

function sourceIdFromReference(sourceRef: string): string {
  if (/^src:pos:v1:second-brain:[a-z0-9][a-z0-9-]{0,63}$/.test(sourceRef)) return sourceRef;
  const slug = sourceRef.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return slug.length === 0 ? "src:pos:v1:second-brain:primary" : `src:pos:v1:second-brain:${slug}`;
}

function assemblerExcerpt(text: string): string {
  const normalized = [...text.normalize("NFC")].map(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  const trimmed = normalized.trim();
  return trimmed.length === 0 ? "memory" : trimmed;
}

function memoriesFromReference(
  selected: {
    payload: {
      records: ReadonlyArray<{
        sid: string; source_ref: string; text: string; text_digest: string;
        observed_at: string; fresh_until: string; sensitivity: string;
      }>;
    };
  },
): MemoryEvidenceInput[] {
  return selected.payload.records.map(record => {
    const excerpt = assemblerExcerpt(record.text);
    const digest = excerpt === record.text && /^sha256:[0-9a-f]{64}$/.test(record.text_digest)
      ? record.text_digest
      : `sha256:${createHash("sha256").update(excerpt).digest("hex")}`;
    return {
      kind: "evidence",
      memory_ref: record.sid.slice(0, 512),
      source_id: sourceIdFromReference(record.source_ref),
      digest,
      observed_at: record.observed_at,
      fresh_until: record.fresh_until,
      excerpt,
      trust: "user_confirmed",
      sensitivity: record.sensitivity === "public" ? "public" : "personal",
      relevance: "related",
      relation: "supports",
    };
  });
}

function persistAssembleInput(base: unknown, now: string, memories: readonly MemoryEvidenceInput[]): Record<string, unknown> {
  const baseObject = base !== null && typeof base === "object" ? base as Record<string, unknown> : {};
  return {
    purpose: typeof baseObject.purpose === "string" ? baseObject.purpose : "operator-context",
    query: queryFromAssemble(base),
    clock: now,
    expires_in_ms: typeof baseObject.expires_in_ms === "number" ? baseObject.expires_in_ms : 300_000,
    budgets: assembleBudgets(base),
    observations: [],
    pending_authority_refs: [],
    memories,
  };
}

function memoryEvidenceId(memory: MemoryEvidenceInput): string {
  const hex = createHash("sha256").update(canonicalize({ digest: memory.digest, reference: memory.memory_ref })).digest("hex");
  return `evi:pos:v1:${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function evidenceForPersist(input: Record<string, unknown>): ContextPersistenceInput["memory_evidence"] {
  const snapshot = assemblePersonalContext(input);
  const memories = Array.isArray(input.memories) ? input.memories as MemoryEvidenceInput[] : [];
  const byRef = new Map(memories.filter(item => item.kind === "evidence").map(item => [item.memory_ref, item]));
  return snapshot.payload.included_memory_refs.map(ref => {
    const memory = byRef.get(ref);
    const item = memory === undefined ? undefined : snapshot.evidence.find(row => row.evidence_id === memoryEvidenceId(memory));
    if (memory === undefined || item === undefined) throw new JarvisError("PERSONAL_CONTEXT_MEMORY_EVIDENCE_CONFLICT");
    return {
      memory_ref: ref,
      evidence_id: item.evidence_id,
      source_id: item.source_id,
      digest: item.digest,
      observed_at: item.observed_at,
      fresh_until: memory.fresh_until,
    };
  });
}

function assembleBudgets(base: unknown): ModelRequestV1["budgets"] {
  if (base !== null && typeof base === "object" && "budgets" in base && base.budgets !== null && typeof base.budgets === "object") {
    const value = base.budgets as Record<string, unknown>;
    if (typeof value.max_items === "number" && typeof value.max_excerpt_bytes === "number" && typeof value.max_total_bytes === "number") {
      return {
        max_items: value.max_items,
        max_excerpt_bytes: value.max_excerpt_bytes,
        max_total_bytes: value.max_total_bytes,
      };
    }
  }
  return { max_items: 8, max_excerpt_bytes: 4_096, max_total_bytes: 16_384 };
}

/** Selected-session transport for explicit gjc.dispatch after configureGjc.
 * JARVIS has no model-session context-compaction event; deletion/correction compaction is not this trigger. */
async function assembleDispatchContext(
  context: CliCommandContext,
  parsed: { assemble_context: unknown; memory_evidence: ContextPersistenceInput["memory_evidence"]; task?: Record<string, unknown> },
  reservation?: { intent_id: string; lease_fence: number },
) {
  if (parsed.assemble_context === undefined) return undefined;
  const options = context.dependencies.memoryReferenceOptions;
  if (options === undefined) throw new JarvisError("MEMORY_REFERENCE_OPTIONS_REQUIRED");
  const sessionId = typeof parsed.task?.session_id === "string" ? parsed.task.session_id : undefined;
  const { read_fence, ...readerOptions } = options;
  void read_fence;
  const produced = createProductionMemoryReference(context.db, {
    ...readerOptions,
    clock: () => commandNow(context),
  });
  try {
    const query = queryFromAssemble(parsed.assemble_context);
    const selected = await produced.reader.read(query, { max_records: 8, max_record_bytes: 4096, max_bytes: 16384 });
    const now = commandNow(context).toISOString();
    const session = new AssembledModelSession(
      context.db,
      options.model_transport ?? new RecordingModelTransport(),
      dispatchMemoryAuthorizer(context, options),
    );
    const persistInput = persistAssembleInput(parsed.assemble_context, now, memoriesFromReference(selected));
    const prepared = await session.prepare(persistInput, evidenceForPersist(persistInput), now, sessionId);
    let attempts = 0;
    await session.send(prepared.capture, {
      beforeSend: () => produced.reader.revalidate(selected),
      ...(reservation === undefined ? {} : {
        beginAttempt: () => {
          attempts += 1;
          if (attempts === 1) {
            context.db.recordGjcSendStarted(reservation.intent_id, reservation.intent_id, now, reservation.lease_fence);
          }
          context.db.recordGjcSendAttemptStarted(reservation.intent_id, `${reservation.lease_fence}:${attempts}`, now, reservation.lease_fence);
        },
        onKnownNegative: () => {
          context.db.recordGjcSendAttemptFailed(reservation.intent_id, `${reservation.lease_fence}:${attempts}`, now, reservation.lease_fence);
          context.db.recordGjcSendFailed(reservation.intent_id, now, reservation.lease_fence);
        },
      }),
    });
    return prepared;
  } finally {
    await produced.close();
  }
}

function parsePostCompactEvent(raw: unknown): { session_id: string; query: string; event_digest: string } {
  if (raw === null || typeof raw !== "object") throw new JarvisError("HOOK_JSON_INVALID");
  const payload = raw as Record<string, unknown>;
  const name = payload.hook_event_name ?? payload.hookEventName;
  switch (name) {
    case "PostCompact":
      break;
    default:
      throw new JarvisError("HOOK_EVENT_UNSUPPORTED");
  }
  const sessionId = payload.session_id;
  const query = payload.query ?? payload.compact_summary;
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new JarvisError("HOOK_SESSION_MISSING");
  if (typeof query !== "string" || query.trim().length === 0) throw new JarvisError("HOOK_QUERY_MISSING");
  const trimmed = query.trim();
  const event_digest = `sha256:${createHash("sha256").update(`${sessionId}\0${trimmed}`).digest("hex")}`;
  return { session_id: sessionId, query: trimmed, event_digest };
}

/** Claude PostCompact (or same JSON) → existing reader reselect → configured model_transport. */
export async function executeMemoryPostcompact(
  context: CliCommandContext,
): Promise<Record<string, unknown>> {
  const options = context.dependencies.memoryReferenceOptions;
  if (options === undefined) throw new JarvisError("MEMORY_REFERENCE_OPTIONS_REQUIRED");
  if (options.model_transport === undefined) throw new JarvisError("MEMORY_MODEL_TRANSPORT_REQUIRED");
  let raw: unknown;
  if (context.argument !== undefined) {
    raw = await jsonFile(context.argument);
  } else {
    const read = context.dependencies.readStdin ?? readProcessStdin;
    try {
      raw = JSON.parse(Buffer.from(await read()).toString("utf8")) as unknown;
    } catch (error) {
      throw new JarvisError("HOOK_JSON_INVALID", error instanceof Error ? error.message : "HOOK_JSON_INVALID");
    }
  }
  const event = parsePostCompactEvent(raw);
  const ledger = postcompactLedgerPath(context);
  const seen = readPostcompactLedger(ledger);
  if (seen.includes(event.event_digest)) {
    return {
      ok: true,
      command: "memory.postcompact",
      duplicate: true,
      transport: "configured",
      event_digest: event.event_digest,
    };
  }
  const assembled = await assembleDispatchContext(context, {
    assemble_context: { query: event.query, purpose: "postcompact-reselect" },
    memory_evidence: [],
    task: { session_id: event.session_id },
  });
  if (assembled === undefined) throw new JarvisError("MEMORY_POSTCOMPACT_ASSEMBLE_MISSING");
  writePostcompactLedger(ledger, [...seen, event.event_digest]);
  return {
    ok: true,
    command: "memory.postcompact",
    model_session_id: assembled.capture.session_id,
    model_request_bytes: assembled.capture.bytes,
    transport: "configured",
    event_digest: event.event_digest,
  };
}

function postcompactLedgerPath(context: CliCommandContext): string {
  const envPath = process.env["JARVIS_POSTCOMPACT_LEDGER"];
  if (envPath !== undefined && envPath.length > 0) return envPath;
  return `${context.db.filename}.postcompact-events.json`;
}

function readPostcompactLedger(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writePostcompactLedger(path: string, events: readonly string[]): void {
  writeFileSync(path, `${JSON.stringify(events)}\n`);
}
