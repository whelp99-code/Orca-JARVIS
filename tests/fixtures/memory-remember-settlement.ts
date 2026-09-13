import { createHash } from "node:crypto";
import { canonicalize } from "../../src/canonical.js";
import { memoryRememberArtifact } from "../../src/memory-remember-artifact.js";
import { generateKeyPairSync } from "node:crypto";
import type { AuthorityDb } from "../../src/db.js";
import { ControlPlane } from "../../src/control-plane.js";
import { signCommandApproval } from "../../src/control-plane-contract.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { MemoryMutationService } from "../../src/dashboard/memory-mutation-service.js";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { MemoryOutboxService } from "../../src/memory-outbox.js";
import { stageMemoryRememberDispatch } from "../../src/memory-remember-dispatch.js";
import { SecondBrainEffectService } from "../../src/second-brain-effect-service.js";
import type { SecondBrainEvidence } from "../../src/second-brain-adapter-types.js";
import { inferredMemoryInput, memoryPolicy, MEMORY_NOW } from "./memory-candidate-fixture.js";
import type { MemoryDatabase } from "./memory-candidate-store.js";
import { FixtureReader, FixtureWriter } from "./memory-outbox-fixture.js";
import { MemoryReferenceProvider } from "./memory-reference-provider.js";
import { localKey } from "../helpers.js";
import { REFERENCE_GENERATION } from "./memory-reference-provider.js";

const hex = (value: string): string => createHash("sha256").update(value).digest("hex");
const digest = (value: string): string => `sha256:${hex(value)}`;

/**
 * One generation for every record a settlement fixture serves.
 *
 * The settlement observer requires a single generation across the records of one write, and a reader
 * driven by the reference provider compares each record's generation against the status that
 * provider reports - so both sides have to be the same one, and it is the provider's.
 */
export const REMEMBER_GENERATION = REFERENCE_GENERATION;

export type RememberArtifactFixture = {
  readonly page_id: string;
  readonly sid: string;
  readonly source_digest: string;
  /** The records a provider serves on that page: no generation, which it reports page-wide. */
  readonly records: readonly Readonly<Record<string, unknown>>[];
  /** The same records as evidence, carrying the generation a reader compares against the status. */
  readonly evidence: readonly SecondBrainEvidence[];
};

/**
 * The destination a remember write derives, and the records a provider would show once it landed.
 *
 * The product decides where a remembered statement goes - page and section both come from the
 * candidate and the content, not from whoever is writing the test - so this asks it, and then builds
 * the evidence that destination would actually carry. Every field the settlement observer checks is
 * computed the way it computes it: one record per line of the statement, contiguous citation spans,
 * content identity over the line, citation identity over page, section and span, and the source
 * identity of the candidate behind the write.
 */
export function rememberArtifact(options: {
  readonly candidate_id: string; readonly statement: string; readonly sensitivity: string;
  readonly observed_at: string; readonly fresh_until: string; readonly expires_at: string;
  readonly valid_until?: string;
}): RememberArtifactFixture {
  const expected = memoryRememberArtifact({ candidate_id: options.candidate_id, operation: "remember",
    payload: { content: options.statement }, sensitivity: options.sensitivity } as never);
  const artifact = expected.artifact;
  let start = 0;
  const evidence = expected.record_texts.map(text => {
    const end = start + Buffer.byteLength(text);
    const core = {
      schema_version: 1, sid: artifact.sid, record_text: text, record_text_digest: digest(text),
      citation_span_start: start, citation_span_end: end,
      source_identity_full: expected.source_identity_full, content_identity_full: hex(text),
      citation_identity_full: hex(`${artifact.page_id}\u0000${artifact.sid}\u0000${start}:${end}`),
      sensitivity: expected.sensitivity, source_owner_class: "provider_owned",
      source_owner_id_digest: digest("owner"), origin_label: "Second Brain",
      valid_from: options.observed_at, valid_until: options.valid_until ?? "2126-09-01T00:00:00.000Z",
    };
    const recordDigest = `sha256:${createHash("sha256").update("second-brain/memory-record/v1\u0000")
      .update(canonicalize(core)).digest("hex")}`;
    start = end;
    return {
      kind: "memory", page_id: artifact.page_id, sid: artifact.sid,
      source_ref: `memory-candidate:${options.candidate_id}`,
      source_id: "src:pos:v1:second-brain:primary", source_version: "sb/0.1.0|v1|fixture",
      sensitivity: expected.sensitivity, observed_at: options.observed_at, valid_at: options.observed_at,
      freshness: { state: "fresh", checked_at: options.observed_at, fresh_until: options.fresh_until },
      expires_at: options.expires_at, trust: "untrusted", authority: "none", excerpt: text,
      content_digest: digest(text), omission: null,
      record: { ...core, record_id: `sbrecord:v1:${recordDigest.slice(7)}`, record_digest: recordDigest,
        generation: REMEMBER_GENERATION },
    } as unknown as SecondBrainEvidence;
  });
  const records = evidence.map(item => {
    const record = { ...(item as unknown as { record: Record<string, unknown> }).record };
    delete record["generation"];
    return record;
  });
  return { page_id: artifact.page_id, sid: artifact.sid, source_digest: artifact.source_digest,
    records, evidence };
}

/**
 * One remember write taken all the way through the product: classified, confirmed by the owner,
 * staged by the dispatch path that derives the destination, and settled against the records that
 * destination would carry. Returns what a caller needs to ask questions about it afterwards.
 */
export async function settleRememberWrite(database: MemoryDatabase, options: {
  readonly statement: string; readonly idempotency_key: string; readonly subject?: string;
  readonly now?: Date; readonly receipt_prefix?: string;
}) {
  const authority = database.authority;
  const now = options.now ?? new Date(MEMORY_NOW);
  const prefix = options.receipt_prefix ?? "settle";
  const reviewRoot = `${database.root}/review`;
  const dispatchRoot = `${database.root}/dispatch`;
  const roots = { candidate_review_spool_root: reviewRoot, candidate_dispatch_spool_root: dispatchRoot };
  const store = new MemoryCandidateStore(authority, memoryPolicy(), () => now);
  store.attachReviewSpool(reviewRoot);
  const candidate = store.classify(inferredMemoryInput({ subject: options.subject ?? "wiki/settled",
    statement: options.statement, idempotency_key: options.idempotency_key }));
  const control = new ControlPlane(authority);
  const sign = (receiptId: string, requestId: string, commandDigest: string, expiresAt: string) =>
    signCommandApproval({ schema_version: 1, receipt_id: receiptId, request_id: requestId,
      decision: "approve", command_digest: commandDigest, signer_principal_id: "principal:owner",
      authenticated_session_id: "owner-session", key_id: "decision-test", algorithm: "Ed25519",
      issued_at: now.toISOString(), not_before: now.toISOString(), expires_at: expiresAt,
      nonce: receiptId, max_uses: 1, status: "issued" }, localKey(authority));
  const mutation = new MemoryMutationService({ authority, clock: () => now,
    session: createDashboardSession("owner-session"),
    tokens: new MemoryTokenCache(Buffer.alloc(32, 1), () => now),
    candidate_review_spool_root: reviewRoot, candidate_dispatch_spool_root: dispatchRoot });
  const confirmation = mutation.stageCandidateDecision({ candidate_id: candidate.candidate_id,
    operation: "remember", decision: "confirm", intent_id: `memui:intent:v1:${"7".repeat(64)}` });
  if (confirmation === undefined) throw new TypeError("confirmation command required");
  control.decide(sign(`${prefix}:confirm`, confirmation.request_id, confirmation.command_digest,
    confirmation.expires_at), now);
  const staged = stageMemoryRememberDispatch(authority, candidate.candidate_id, now, roots);
  control.decide(sign(`${prefix}:dispatch`, staged.request_id, staged.command_digest, staged.expires_at), now);
  const settlement = rememberArtifact({ candidate_id: candidate.candidate_id,
    statement: options.statement, sensitivity: "personal", observed_at: now.toISOString(),
    fresh_until: "2026-08-28T13:00:00.000Z", expires_at: "2026-08-29T12:00:00.000Z" });
  const outbox = new MemoryOutboxService({ authority, writer: new FixtureWriter(),
    reader: new FixtureReader({ kind: "current", checked_at: now.toISOString(),
      evidence: [...settlement.evidence] }), clock: () => now,
    artifactDeadlineMs: 30_000, leaseMs: 10_000,
    candidate_dispatch_spool_root: dispatchRoot, candidate_review_spool_root: reviewRoot });
  const queued = outbox.enqueue(control.claim(staged.request_id, `${prefix}-worker`, now));
  if ((await outbox.runOnce(`${prefix}-worker`, 1)).settled !== 1) throw new TypeError("settlement required");
  if (outbox.get(queued.outbox_id)?.state !== "settled") throw new TypeError("settled state required");
  const record = settlement.records[0];
  if (record === undefined) throw new TypeError("settled record required");
  return { authority, candidate, settlement, record, page: { page_id: settlement.page_id, record } };
}

/** Resolves the provider's target for a settled record through the product's own effect service. */
export async function resolveSettledTarget(
  authority: AuthorityDb, page: { readonly page_id: string; readonly record: Readonly<Record<string, unknown>> },
  now: Date, keyId = "memory-effect-settled",
): Promise<void> {
  const effect = new SecondBrainEffectService({ authority, transport: new MemoryReferenceProvider(page),
    writer: { write: () => Promise.reject(new Error("fixture performs no write")) }, clock: () => now,
    provider_instance_id: REFERENCE_GENERATION.provider_instance_id, signing_key_id: keyId,
    private_key: generateKeyPairSync("ed25519").privateKey });
  const resolved = await effect.resolveTarget({ record_id: String(page.record["record_id"]),
    record_digest: String(page.record["record_digest"]),
    generation_id: REFERENCE_GENERATION.generation_id,
    generation_manifest_digest: REFERENCE_GENERATION.generation_manifest_digest });
  if (resolved.kind !== "data") throw new TypeError(`target resolution required: ${resolved.kind}`);
}
