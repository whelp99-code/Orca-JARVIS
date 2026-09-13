import type { MemoryInput } from "./context-assembler-input.js";
import type { AuthorityDb } from "./db.js";
import { candidateTaskSourceClosed } from "./memory-candidate-task-source.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import type { PreparedMemoryReference } from "./memory-reference-context.js";
import { SECOND_BRAIN_SOURCE_ID } from "./second-brain-adapter-types.js";

type SettledCandidate = { readonly candidate_id: string; readonly content_digest: string };

/**
 * The candidate this database sent to the provider for the page and section a record came back on.
 *
 * A write acceptance carries no provider record identity - it names the candidate, the request and
 * the inbox path, because at that moment the provider has not produced a record yet. What the
 * outbox does carry is the page and section the write was expected to land on, and a settled row
 * means the reconciliation observed that artifact. So this is the correspondence the product
 * already holds: not a shared content hash, which the two sides compute differently, but the
 * destination the owner approved writing to.
 *
 * Only a remember write puts a memory record on a page, so only those are asked about; a forget or
 * an export names a destination for its own reasons. And a destination has to identify exactly one
 * candidate: the page a remember write derives carries the candidate in it, so two of ours cannot
 * land on one, but if this database ever holds two that say they did, it cannot tell whose record
 * this is - and picking whichever row came back first would be an answer it has not got.
 */
function settledCandidateFor(authority: AuthorityDb, pageId: string, sid: string): SettledCandidate | undefined {
  const rows = authority.db.prepare(
    `SELECT o.candidate_id AS candidate_id, c.content_digest AS content_digest
     FROM memory_outbox o
     JOIN memory_candidates c ON c.candidate_id=o.candidate_id
     WHERE o.state='settled' AND o.operation='remember'
       AND o.expected_page_id=? AND o.expected_sid=?
     ORDER BY o.candidate_id LIMIT 2`).all(pageId, sid) as
    { candidate_id: string; content_digest: string }[];
  const row = rows.length === 1 ? rows[0] : undefined;
  return row === undefined
    ? undefined
    : { candidate_id: String(row.candidate_id), content_digest: String(row.content_digest) };
}

/**
 * True when the owner's own confirmation for this candidate's content is on record.
 *
 * The decision, the applied attempt and the approved receipt the owner signed, joined so that a
 * staged or rejected decision proves nothing. A revoked approval proves nothing either.
 */
export function ownerConfirmedContent(authority: AuthorityDb, contentDigest: string): boolean {
  return ownerImportDecisionFor(authority, contentDigest) !== null;
}

/**
 * True when the owner's confirmation is on record for exactly this candidate.
 *
 * A confirmation is of a candidate, not of a sentence. Two candidates can carry the same statement
 * and reach the provider by different roads - one the owner was asked about and approved, one that
 * needed no confirmation and was published automatically - and reading the answer by content lets
 * the second borrow the first's permission. The candidate whose write actually landed on the record
 * in hand is the one that has to have been confirmed, and it must not have been suppressed since.
 */
export function ownerConfirmedCandidate(authority: AuthorityDb, candidateId: string): boolean {
  if (new MemoryProjectionAuthority(authority).isProjectionIdSuppressed(candidateId)) return false;
  return authority.db.prepare(
    `SELECT 1 FROM memory_candidate_owner_decisions d
     JOIN memory_candidate_decision_attempts t ON t.attempt_id=d.attempt_id AND t.state='applied'
     JOIN control_command_requests r ON r.request_id=d.control_request_id
       AND r.requested_by='principal:owner' AND r.state IN ('approved','claimed','completed')
     JOIN control_command_receipts a ON a.receipt_id=d.control_receipt_id AND a.request_id=r.request_id
       AND a.decision='approve' AND a.signer_principal_id='principal:owner'
       AND a.command_digest=r.command_digest
     WHERE d.decision='confirm' AND d.candidate_id=?
       AND NOT EXISTS(SELECT 1 FROM control_command_revocations v
         WHERE v.request_id=r.request_id OR v.receipt_id=a.receipt_id)
     LIMIT 1`).get(candidateId) !== undefined;
}

/**
 * The control request by which the owner admitted this content, or null when there is none.
 *
 * A principle rests on an owner decision, and in this product that decision is not a second,
 * separate approval: it is the owner's own confirmation of the memory, which the control plane
 * holds as an approved, unrevoked, owner-signed request. Naming it here is what keeps the daily run
 * from being handed a reference it never earned.
 */
export function ownerImportDecisionFor(authority: AuthorityDb, contentDigest: string): string | null {
  const value = authority.db.prepare(
    `SELECT d.control_request_id AS control_request_id FROM memory_candidate_owner_decisions d
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
     ORDER BY d.control_request_id LIMIT 1`).pluck().get(contentDigest);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The target identity this database resolved for exactly this record, or undefined.
 *
 * A record carries three identities the provider computed - its source, its content and its
 * citation - and a resolved target repeats all three. Matching on the triple is what says "the
 * target we resolved is this record", without trusting the response to tell us so.
 */
function resolvedTargetFor(authority: AuthorityDb,
  record: { readonly source_identity_full: string; readonly content_identity_full: string;
    readonly citation_identity_full: string }): string | undefined {
  const value = authority.db.prepare(
    `SELECT target_id FROM memory_resolved_target_metadata
     WHERE source_identity_digest=? AND content_identity_digest=? AND citation_identity_digest=?
     ORDER BY target_id LIMIT 1`).pluck()
    .get(record.source_identity_full, record.content_identity_full, record.citation_identity_full);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * What a verified provider read may contribute to an assembled context.
 *
 * The read contract is explicit about itself: its payload carries `trust: "untrusted"` and
 * `authority: "none"`, and its own documentation says it builds reference data and never a
 * confirmed fact. So nothing here promotes a returned record on the strength of having read it.
 * Three things have to hold first, and this database answers each of them rather than the response:
 *
 * - the record has to come back on a page and section a settled write of ours landed on, which is
 *   what names the candidate behind it;
 * - that candidate's task must not be closed, asked again here because a read that began before
 *   the owner hid a task returns after they did;
 * - the owner's confirmation has to be on record for that candidate itself, not merely for the
 *   same words on some other candidate;
 * - and the target identity for that record has to be one this database resolved, because an
 *   artifact resting on a memory has to stay suppressible: when the owner later forgets it, the
 *   projection authority reaches the context and everything published from it through exactly that
 *   identity. A record we cannot name that way is material we may read but not rest on.
 *
 * The memory is therefore named by the resolved target, while a gap keeps the record's own id -
 * there is no target to name in that case, and the caller still learns which record it was.
 *
 * Anything else becomes the assembler's own gap, which is how a caller says "there is material
 * here that I may not use" without the assembler having to guess why.
 */
export function contextMemoryFromReference(
  authority: AuthorityDb, reference: PreparedMemoryReference,
): readonly MemoryInput[] {
  return reference.payload.records.map(row => {
    const memoryRef = row.record.record_id;
    const gap = (state: "no_data" | "unavailable"): MemoryInput =>
      ({ kind: "gap", memory_ref: memoryRef, state });
    const candidate = settledCandidateFor(authority, row.page_id, row.sid);
    if (candidate === undefined) return gap("no_data");
    if (candidateTaskSourceClosed(authority, candidate.candidate_id)) return gap("unavailable");
    if (!ownerConfirmedCandidate(authority, candidate.candidate_id)) return gap("no_data");
    const target = resolvedTargetFor(authority, row.record);
    if (target === undefined) return gap("no_data");
    return { kind: "evidence", memory_ref: target, source_id: SECOND_BRAIN_SOURCE_ID,
      digest: candidate.content_digest, observed_at: row.observed_at, fresh_until: row.fresh_until,
      excerpt: row.text, trust: "user_confirmed", sensitivity: row.sensitivity,
      relevance: "related", relation: "supports" };
  });
}
