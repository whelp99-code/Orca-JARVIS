import type { MemoryInput } from "./context-assembler-input.js";
import type { AuthorityDb } from "./db.js";
import { candidateTaskSourceClosed } from "./memory-candidate-task-source.js";
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
 */
function settledCandidateFor(authority: AuthorityDb, pageId: string, sid: string): SettledCandidate | undefined {
  const row = authority.db.prepare(
    `SELECT o.candidate_id AS candidate_id, c.content_digest AS content_digest
     FROM memory_outbox o
     JOIN memory_candidates c ON c.candidate_id=o.candidate_id
     WHERE o.state='settled' AND o.expected_page_id=? AND o.expected_sid=? LIMIT 1`)
    .get(pageId, sid) as { candidate_id: string; content_digest: string } | undefined;
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
 * Three things have to hold first, and this database answers each of them rather than the response:
 *
 * - the record has to come back on a page and section a settled write of ours landed on, which is
 *   what names the candidate behind it;
 * - that candidate's task must not be closed, asked again here because a read that began before
 *   the owner hid a task returns after they did;
 * - the owner's confirmation for that candidate's content has to be on record.
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
    if (!ownerConfirmedContent(authority, candidate.content_digest)) return gap("no_data");
    return { kind: "evidence", memory_ref: memoryRef, source_id: SECOND_BRAIN_SOURCE_ID,
      digest: candidate.content_digest, observed_at: row.observed_at, fresh_until: row.fresh_until,
      excerpt: row.text, trust: "user_confirmed", sensitivity: row.sensitivity,
      relevance: "related", relation: "supports" };
  });
}
