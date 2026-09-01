import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "./canonical.js";
import {
  assertPrivateSpoolRoot,
  openPrivateSpoolRoot,
  readPrivateSpoolFile,
  removePrivateSpoolFile,
  type PrivateSpoolRoot,
  writePrivateSpoolFile,
} from "./memory-private-spool-files.js";
import { parseSecondBrainStrictJsonBytes } from "./second-brain-strict-json.js";
import type {
  MemoryCandidateClassification,
  MemoryCandidateComputation,
  ParsedMemoryCandidateInput,
} from "./memory-candidate-types.js";

const REVIEW_DOMAIN = "orca-jarvis/memory-candidate-review/v1\0";
const CANDIDATE_ID = /^memcand:pos:v1:[0-9a-f]{64}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_CONTENT_BYTES = 4096;

export type MemoryCandidateReviewEnvelope = {
  readonly schema_version: 1;
  readonly candidate_id: string;
  readonly candidate_digest: string;
  readonly classification_digest: string;
  readonly subject_digest: string;
  readonly content_digest: string;
  readonly operation: "remember" | "correct";
  readonly subject: string;
  readonly statement: string;
  readonly purpose: string;
  readonly sensitivity: "public" | "personal" | "sensitive" | "restricted";
  readonly source_class: string;
  readonly source_id: string;
  readonly source_version: string;
  readonly policy_digest: string;
  readonly idempotency_key: string;
  readonly request_id: string;
  readonly request_digest: string;
  readonly retention_days: number;
  readonly created_at: string;
  readonly candidate_expires_at: string;
  readonly confirmation_expires_at: string;
  readonly review_envelope_digest: string;
};

export type MemoryCandidateReviewPublication = {
  readonly candidate_id: string;
  readonly path: string;
  readonly review_spool_digest: string;
  readonly content_bytes: number;
  readonly expires_at: string;
  readonly created: boolean;
};

type SpoolRecord = MemoryCandidateReviewEnvelope;

const digest = (value: Omit<MemoryCandidateReviewEnvelope, "review_envelope_digest">): string =>
  `sha256:${createHash("sha256").update(REVIEW_DOMAIN).update(canonicalize(value)).digest("hex")}`;

export type MemoryCandidateReviewEnvelopeInput = {
  readonly input: ParsedMemoryCandidateInput;
  readonly computation: MemoryCandidateComputation;
  readonly classification: MemoryCandidateClassification;
};

export function createMemoryCandidateReviewEnvelope(
  value: MemoryCandidateReviewEnvelopeInput,
): MemoryCandidateReviewEnvelope {
  const { input, computation, classification } = value;
  if (!classification.required_confirmation || classification.state !== "awaiting_confirmation"
    || classification.confirmation_expires_at === null) {
    throw new Error("MEMORY_REVIEW_NOT_ELIGIBLE");
  }
  const core: Omit<MemoryCandidateReviewEnvelope, "review_envelope_digest"> = {
    schema_version: 1,
    candidate_id: classification.candidate_id,
    candidate_digest: classification.candidate_digest,
    classification_digest: classification.classification_digest,
    subject_digest: classification.subject_digest,
    content_digest: classification.content_digest,
    operation: classification.operation,
    subject: input.subject,
    statement: input.statement,
    purpose: input.purpose,
    sensitivity: input.sensitivity,
    source_class: input.source.input_class,
    source_id: input.source.source_id,
    source_version: input.source.source_version,
    policy_digest: classification.policy_digest,
    idempotency_key: `memidem:pos:v1:${computation.idempotency_digest.slice(7)}`,
    request_id: `memreq:pos:v1:${computation.request_digest.slice(7)}`,
    request_digest: computation.request_digest,
    retention_days: classification.retention_days,
    created_at: classification.created_at,
    candidate_expires_at: classification.candidate_expires_at,
    confirmation_expires_at: classification.confirmation_expires_at,
  };
  return { ...core, review_envelope_digest: digest(core) };
}

export class MemoryCandidateReviewSpool {
  private readonly spool: PrivateSpoolRoot;

  constructor(private readonly root: string) {
    this.spool = openPrivateSpoolRoot(root);
  }

  publish(envelope: MemoryCandidateReviewEnvelope): MemoryCandidateReviewPublication {
    validateReviewEnvelope(envelope);
    const bytes = Buffer.from(canonicalize(envelope), "utf8");
    const contentBytes = Buffer.byteLength(envelope.statement, "utf8");
    if (contentBytes < 1 || contentBytes > MAX_CONTENT_BYTES) throw new Error("MEMORY_REVIEW_TOO_LARGE");
    const path = this.filePath(envelope.candidate_id);
    const created = writePrivateSpoolFile(this.spool, path, bytes, "review");
    const existing = readReviewFile(this.spool, path);
    if (existing.review_envelope_digest !== envelope.review_envelope_digest) {
      throw new Error("MEMORY_REVIEW_REPLAY_CONFLICT");
    }
    return {
      candidate_id: envelope.candidate_id,
      path,
      review_spool_digest: envelope.review_envelope_digest,
      content_bytes: contentBytes,
      expires_at: envelope.confirmation_expires_at,
      created,
    };
  }

  read(candidateId: string): MemoryCandidateReviewEnvelope {
    return readReviewFile(this.spool, this.filePath(candidateId));
  }

  remove(publication: MemoryCandidateReviewPublication): void {
    const current = readReviewFile(this.spool, publication.path);
    if (current.candidate_id !== publication.candidate_id
      || current.review_envelope_digest !== publication.review_spool_digest) {
      throw new Error("MEMORY_REVIEW_REPLAY_CONFLICT");
    }
    removePrivateSpoolFile(this.spool, publication.path);
  }

  paths(): readonly string[] {
    assertPrivateSpoolRoot(this.spool);
    return readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
      .map(entry => join(this.root, entry.name));
  }

  private filePath(candidateId: string): string {
    if (!CANDIDATE_ID.test(candidateId)) throw new Error("MEMORY_REVIEW_CANDIDATE_INVALID");
    return join(this.root, `${candidateId.replaceAll(":", "_")}.json`);
  }
}

export function memoryCandidateReviewDigest(envelope: MemoryCandidateReviewEnvelope): string {
  const core = Object.fromEntries(Object.entries(envelope)
    .filter(([key]) => key !== "review_envelope_digest")) as Omit<MemoryCandidateReviewEnvelope, "review_envelope_digest">;
  return digest(core);
}

function readReviewFile(root: PrivateSpoolRoot, path: string): SpoolRecord {
  const parsed = parseSecondBrainStrictJsonBytes(readPrivateSpoolFile(root, path));
  if (!isReviewRecord(parsed) || memoryCandidateReviewDigest(parsed) !== parsed.review_envelope_digest) {
    throw new Error("MEMORY_REVIEW_INTEGRITY_FAILURE");
  }
  return parsed;
}

function validateReviewEnvelope(value: MemoryCandidateReviewEnvelope): void {
  if (!isReviewRecord(value) || memoryCandidateReviewDigest(value) !== value.review_envelope_digest) {
    throw new Error("MEMORY_REVIEW_INTEGRITY_FAILURE");
  }
}

function isReviewRecord(value: unknown): value is MemoryCandidateReviewEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = [
    "schema_version", "candidate_id", "candidate_digest", "classification_digest", "subject_digest",
    "content_digest", "operation", "subject", "statement", "purpose", "sensitivity", "source_class",
    "source_id", "source_version", "policy_digest", "idempotency_key", "request_id", "request_digest",
    "retention_days", "created_at", "candidate_expires_at", "confirmation_expires_at",
    "review_envelope_digest",
  ];
  if (Object.keys(record).length !== keys.length || keys.some(key => !(key in record))) return false;
  return record.schema_version === 1
    && typeof record.candidate_id === "string" && CANDIDATE_ID.test(record.candidate_id)
    && typeof record.candidate_digest === "string" && DIGEST.test(record.candidate_digest)
    && typeof record.classification_digest === "string" && DIGEST.test(record.classification_digest)
    && typeof record.subject_digest === "string" && DIGEST.test(record.subject_digest)
    && typeof record.content_digest === "string" && DIGEST.test(record.content_digest)
    && (record.operation === "remember" || record.operation === "correct")
    && typeof record.subject === "string" && typeof record.statement === "string"
    && typeof record.purpose === "string"
    && (record.sensitivity === "public" || record.sensitivity === "personal"
      || record.sensitivity === "sensitive" || record.sensitivity === "restricted")
    && typeof record.source_class === "string" && typeof record.source_id === "string"
    && typeof record.source_version === "string" && typeof record.policy_digest === "string"
    && DIGEST.test(record.policy_digest) && typeof record.idempotency_key === "string"
    && /^memidem:pos:v1:[0-9a-f]{64}$/u.test(record.idempotency_key)
    && typeof record.request_id === "string" && /^memreq:pos:v1:[0-9a-f]{64}$/u.test(record.request_id)
    && typeof record.request_digest === "string" && DIGEST.test(record.request_digest)
    && typeof record.retention_days === "number" && Number.isSafeInteger(record.retention_days)
    && typeof record.created_at === "string" && typeof record.candidate_expires_at === "string"
    && typeof record.confirmation_expires_at === "string"
    && typeof record.review_envelope_digest === "string" && DIGEST.test(record.review_envelope_digest);
}

