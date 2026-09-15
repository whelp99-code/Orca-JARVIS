import { createHash } from "node:crypto";
import { type CliCommandContext, commandNow } from "./cli-command-context.js";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { AssembledModelSession } from "./assembled-model-session.js";
import { assemblePersonalContext, type MemoryEvidenceInput, type ModelRequestV1 } from "./context-assembler.js";
import { createProductionMemoryReadFence } from "./memory-read-fence-production.js";
import { createProductionMemoryReference } from "./memory-reference-production.js";
import type { ContextPersistenceInput } from "./personal-context-store.js";

export function parseDispatchEnvelope(raw: Record<string, unknown>): {
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

export function preflightDispatchAssemble(
  context: CliCommandContext,
  parsed: { assemble_context: unknown; memory_evidence: ContextPersistenceInput["memory_evidence"] },
): void {
  if (parsed.assemble_context === undefined) return;
  const options = context.dependencies.memoryReferenceOptions;
  if (options === undefined) throw new JarvisError("MEMORY_REFERENCE_OPTIONS_REQUIRED");
  if (options.model_transport === undefined) throw new JarvisError("MEMORY_MODEL_TRANSPORT_REQUIRED");
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
        record: { record_id: string; record_digest: string };
      }>;
    };
  },
): MemoryEvidenceInput[] {
  return selected.payload.records.map(row => {
    const excerpt = assemblerExcerpt(row.text);
    const digest = row.record.record_digest;
    return {
      kind: "evidence",
      memory_ref: row.record.record_id.slice(0, 512),
      source_id: sourceIdFromReference(row.source_ref),
      digest,
      observed_at: row.observed_at,
      fresh_until: row.fresh_until,
      excerpt,
      trust: "user_confirmed",
      sensitivity: row.sensitivity === "public" ? "public" : "personal",
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
export async function assembleDispatchContext(
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
    if (options.model_transport === undefined) throw new JarvisError("MEMORY_MODEL_TRANSPORT_REQUIRED");
    const session = new AssembledModelSession(
      context.db,
      options.model_transport,
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
