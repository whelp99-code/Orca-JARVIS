import { JarvisError, type AuthorityDb } from "./db.js";
import { readMemoryCandidate } from "./memory-candidate-reader.js";
import { prepareMemoryScopedWriteIdentity } from "./memory-scoped-write-identity.js";
import { parseMemoryPlainText } from "./memory-plain-text.js";
import { memoryHash } from "./memory-candidate-values.js";
import { resolveSpooledDispatch, type SpooledDispatchInput } from "./memory-outbox-dispatch-request.js";
import { hasSecondBrainWriteAuthority } from "./second-brain-write-authority.js";

/** Product preparation path: recover exact bytes from the bounded private spools
 * and recheck the original write authority before preparing scoped material. */
export function prepareMemoryScopedWriteFromDispatch(authority: AuthorityDb, proposal: unknown,
  reviewRequestId: string, dispatch: Omit<SpooledDispatchInput, "candidate_id" | "now">, now: Date) {
  return authority.db.transaction(() => {
    const binding = prepareMemoryScopedWriteIdentity(authority, proposal, reviewRequestId, now);
    const request = resolveSpooledDispatch({ ...dispatch, candidate_id: binding.identity.candidate_id, now });
    if (request.operation !== "remember" || !hasSecondBrainWriteAuthority(authority, request, now)) {
      throw new JarvisError("MEMORY_SCOPED_SOURCE_AUTHORITY_INVALID");
    }
    return prepareMemoryScopedWritePayload(authority, proposal, reviewRequestId,
      request.subject, request.payload.content, now);
  })();
}

/** Prepare exact candidate bytes for a scoped request. This is not a dispatch
 * request: current source authority/policy and atomic approval consumption remain
 * mandatory at enqueue time. No caller-supplied content is trusted by its label. */
export function prepareMemoryScopedWritePayload(authority: AuthorityDb, proposal: unknown,
  reviewRequestId: string, subject: unknown, content: unknown, now: Date) {
  return authority.db.transaction(() => {
    const binding = prepareMemoryScopedWriteIdentity(authority, proposal, reviewRequestId, now);
    const candidate = readMemoryCandidate(authority.db, binding.identity.candidate_id);
    if (candidate === undefined || candidate.state !== "approved" || candidate.operation !== "remember"
      || typeof subject !== "string" || subject.length === 0 || subject !== subject.normalize("NFC")
      || parseMemoryPlainText(content) === undefined
      || memoryHash("orca-jarvis/memory-subject/v1\0", subject) !== candidate.subject_digest
      || memoryHash("orca-jarvis/memory-content/v1\0", content) !== candidate.content_digest) {
      throw new JarvisError("MEMORY_SCOPED_PAYLOAD_INVALID");
    }
    const payload = Object.freeze({ subject, content: content as string,
      subject_digest: candidate.subject_digest, content_digest: candidate.content_digest,
      purpose: candidate.purpose, sensitivity: candidate.policy_sensitivity, retention_days: candidate.retention_days });
    const prepared = Object.freeze({ schema_version: 1 as const, profile: "scoped-remember-preparation-v1" as const,
      binding, payload, writes_authorized: false as const });
    return Object.freeze({ ...prepared,
      preparation_digest: memoryHash("orca-jarvis/memory-scoped-write-preparation/v1\0", prepared) });
  })();
}
