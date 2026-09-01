import { createHash } from "node:crypto";
import type { AuthorityDb } from "../../src/db.js";
import type { SecondBrainReadAdapter } from "../../src/second-brain-adapter-types.js";
import { MEMORY_TOMBSTONE_GENESIS_ROOT } from "../../src/second-brain-effect-v2.js";
import {
  MemoryCandidateReviewSpool,
  memoryCandidateReviewDigest,
  type MemoryCandidateReviewEnvelope,
} from "../../src/memory-candidate-review-spool.js";

/** Run-owned QA rows that let the real dashboard render candidate and effect states. */
const NOW = "2026-09-01T00:00:00.000Z";
const EXPIRES = "2126-09-01T00:00:00.000Z";
const HEX = createHash("sha256").update("task32v6qa0001").digest("hex");
export const TASK32_QA_CANDIDATE_ID = `memcand:pos:v1:${HEX}`;

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(`task32-v6-qa\0${value}`).digest("hex")}`;
}

function seedCandidate(db: AuthorityDb, id: string): {
  readonly candidate_digest: string; readonly classification_digest: string; readonly content_digest: string;
  readonly subject_digest: string; readonly policy_digest: string;
} {
  const contentDigest = digest(`${id}\0content`);
  const subjectDigest = digest(`${id}\0subject`);
  const candidateDigest = digest(`${id}\0candidate`);
  const classificationDigest = digest(`${id}\0classification`);
  const policyDigest = digest(`${id}\0policy`);
  db.db.prepare(
    `INSERT INTO memory_candidates(candidate_id,correlation_id,idempotency_key,candidate_kind,operation,
     subject_digest,content_digest,source_digest,sensitivity,purpose,required_confirmation,state,
     confirmation_expires_at,expires_at,created_at,updated_at)
     VALUES(?,?,?,'verified_fact','remember',?,?,?,'sensitive','memory-surface-qa',1,
     'proposed',?,?,?,?)`,
  ).run(id, digest(`${id}\0correlation`), digest(`${id}\0idempotency`), subjectDigest,
    contentDigest, digest(`${id}\0source`), EXPIRES, EXPIRES, NOW, NOW);
  db.db.prepare(
    `INSERT INTO memory_candidate_classifications(candidate_id,schema_version,input_digest,
     identity_source_digest,candidate_digest,input_class,confidence,policy_sensitivity,retention_days,
     policy_digest,classification_reason,classification_digest,dedup_key,source_id,source_version,
     owner_principal,conflict_state,delivery_state,created_at)
     VALUES(?,1,?,?,?,'verified_outcome','verified','sensitive',30,?,
     'Verified outcome retained under policy',?,?,'second-brain-primary','sb-0-1-0',
     'owner','none','pending',?)`,
  ).run(id, digest(`${id}\0input`), digest(`${id}\0identity`), candidateDigest,
    policyDigest, classificationDigest, digest(`${id}\0dedup`), NOW);
  const advance = db.db.prepare("UPDATE memory_candidates SET state=?,updated_at=? WHERE candidate_id=?");
  advance.run("classified", NOW, id);
  advance.run("awaiting_confirmation", NOW, id);
  return { candidate_digest: candidateDigest, classification_digest: classificationDigest,
    content_digest: contentDigest, subject_digest: subjectDigest, policy_digest: policyDigest };
}

function publishReview(root: string, id: string, seeded: ReturnType<typeof seedCandidate>): void {
  const core: Omit<MemoryCandidateReviewEnvelope, "review_envelope_digest"> = {
    schema_version: 1, candidate_id: id, candidate_digest: seeded.candidate_digest,
    classification_digest: seeded.classification_digest, subject_digest: seeded.subject_digest,
    content_digest: seeded.content_digest, operation: "remember",
    subject: "QA owner confirmation candidate",
    statement: "Fictional cited evidence retained for dashboard review.",
    purpose: "personal_memory", sensitivity: "sensitive", source_class: "verified_outcome",
    source_id: "second-brain-primary", source_version: "sb-0-1-0",
    policy_digest: seeded.policy_digest,
    idempotency_key: `memidem:pos:v1:${HEX}`,
    request_id: `memreq:pos:v1:${HEX}`,
    request_digest: digest(`${id}\0request`),
    retention_days: 30, created_at: NOW, candidate_expires_at: EXPIRES,
    confirmation_expires_at: EXPIRES,
  };
  const envelope = { ...core, review_envelope_digest: memoryCandidateReviewDigest({
    ...core, review_envelope_digest: `sha256:${"0".repeat(64)}` }) };
  new MemoryCandidateReviewSpool(root).publish(envelope);
}

export function seedTask32QaRows(db: AuthorityDb, reviewRoot?: string): string {
  const id = TASK32_QA_CANDIDATE_ID;
  db.db.transaction(() => {
    const seeded = seedCandidate(db, id);
    if (reviewRoot !== undefined) publishReview(reviewRoot, id, seeded);
  })();
  return id;
}

export async function seedForgottenRemovals(
  db: AuthorityDb, adapter: SecondBrainReadAdapter,
): Promise<void> {
  const outcome = await adapter.search("evidence");
  if (outcome.kind !== "current") return;
  const records = outcome.evidence.map(item => item.record).filter(item => item !== null);
  if (records.length === 0) return;
  const setRoot = digest("forgotten-set-root");
  db.db.prepare(
    `INSERT INTO memory_tombstone_chain(sequence,tombstone_id,operation,lane_id,target_manifest_digest,
     scope_digest,authority_receipt_digest,payload_digest,keyed_subject_digest,effective_at,previous_root,
     set_root,created_at) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(`memtomb:v1:${HEX}`, "forget", "task32-qa-forgotten", digest("forgotten-manifest"),
    digest("forgotten-scope"), digest("forgotten-receipt"), digest("forgotten-payload"),
    `hmac-sha256:${HEX}`, NOW, MEMORY_TOMBSTONE_GENESIS_ROOT, setRoot, NOW);
  const insert = db.db.prepare(
    `INSERT INTO memory_suppressions(suppression_id,sequence,operation,target_digest,target_manifest_digest,
     scope_digest,keyed_subject_digest,source_identity_digest,content_identity_digest,citation_identity_digest,
     state,effective_at,created_at) VALUES(?,1,'forget',?,?,?,?,?,?,?,'active',?,?)`);
  for (const [index, record] of records.entries()) {
    insert.run(`memsup:v1:${digest(String(index)).slice(7, 23)}${"0".repeat(48)}`, record.record_digest,
      digest("forgotten-manifest"), digest("forgotten-scope"), `hmac-sha256:${HEX}`,
      record.source_identity_full, record.content_identity_full, record.citation_identity_full, NOW, NOW);
  }
}
