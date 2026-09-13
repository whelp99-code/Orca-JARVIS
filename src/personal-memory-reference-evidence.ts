import type { MemoryInput } from "./context-assembler-input.js";
import type { AuthorityDb } from "./db.js";
import { derivedMemoryTaskClosed } from "./memory-candidate-task-source.js";
import type { PreparedMemoryReference } from "./memory-reference-context.js";
import { SECOND_BRAIN_SOURCE_ID } from "./second-brain-adapter-types.js";

/** The identity this database can name for a record the provider returned, or nothing. */
function resolvedIdentity(authority: AuthorityDb, contentIdentity: string): string | undefined {
  const value = authority.db.prepare(
    `SELECT content_identity_digest FROM memory_resolved_target_metadata
     WHERE replace(content_identity_digest,'sha256:','')=replace(?,'sha256:','') LIMIT 1`)
    .pluck().get(contentIdentity);
  return typeof value === "string" ? value : undefined;
}

/**
 * True when the owner's own confirmation for this content is on record.
 *
 * The decision, the applied attempt and the approved receipt the owner signed, joined so that a
 * staged or rejected decision proves nothing. A revoked approval proves nothing either.
 */
export function ownerConfirmedContent(authority: AuthorityDb, contentDigest: string): boolean {
  return authority.db.prepare(
    `SELECT 1 FROM memory_candidate_owner_decisions d
     JOIN memory_candidates c ON c.candidate_id=d.candidate_id
     JOIN memory_candidate_decision_attempts t ON t.attempt_id=d.attempt_id AND t.state='applied'
     JOIN control_command_requests r ON r.request_id=d.control_request_id
       AND r.requested_by='principal:owner' AND r.state IN ('approved','claimed','completed')
     JOIN control_command_receipts a ON a.receipt_id=d.control_receipt_id AND a.request_id=r.request_id
       AND a.decision='approve' AND a.signer_principal_id='principal:owner'
       AND a.command_digest=r.command_digest
     WHERE d.decision='confirm'
       AND replace(c.content_digest,'sha256:','')=replace(?,'sha256:','')
       AND NOT EXISTS(SELECT 1 FROM control_command_revocations v
         WHERE v.request_id=r.request_id OR v.receipt_id=a.receipt_id)
     LIMIT 1`).get(contentDigest) !== undefined;
}

/**
 * What a verified provider read may contribute to an assembled context.
 *
 * The read contract is explicit about itself: its payload carries `trust: "untrusted"` and
 * `authority: "none"`, and its own documentation says it builds reference data and never a
 * confirmed fact. So nothing here promotes a returned record on the strength of having read it.
 * Three things have to hold before a record becomes evidence, and each is answered by this
 * database rather than by the response:
 *
 * - the identity has to be one this database can name, which is a target it resolved earlier;
 * - the task that produced it must not be closed, asked again here because a read that began
 *   before the owner hid a task returns after they did;
 * - the owner's confirmation has to be on record.
 *
 * Anything else is returned as the assembler's own gap, which is how a caller says "there is
 * material here that I may not use" without the assembler having to guess.
 */
export function contextMemoryFromReference(
  authority: AuthorityDb, reference: PreparedMemoryReference,
): readonly MemoryInput[] {
  return reference.payload.records.map(row => {
    const identity = `sha256:${row.record.content_identity_full}`;
    const memoryRef = row.record.record_id;
    const gap = (state: "no_data" | "unavailable"): MemoryInput =>
      ({ kind: "gap", memory_ref: memoryRef, state });
    if (resolvedIdentity(authority, identity) === undefined) return gap("no_data");
    if (derivedMemoryTaskClosed(authority, identity)) return gap("unavailable");
    if (!ownerConfirmedContent(authority, identity)) return gap("no_data");
    return { kind: "evidence", memory_ref: memoryRef, source_id: SECOND_BRAIN_SOURCE_ID,
      digest: identity, observed_at: row.observed_at, fresh_until: row.fresh_until,
      excerpt: row.text, trust: "user_confirmed", sensitivity: row.sensitivity,
      relevance: "related", relation: "supports" };
  });
}
