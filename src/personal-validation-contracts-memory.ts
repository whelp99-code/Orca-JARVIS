import {
  MEMORY_CANDIDATE_KINDS,
  MEMORY_CONFIDENCE_STATES,
  MEMORY_CONFIRMATION_STATES,
  MEMORY_OPERATIONS,
  MEMORY_OUTBOX_STATES,
  MEMORY_STATES,
  SENSITIVITY_TIERS,
  type MemoryCandidateId,
  type MemoryCandidatePayloadV1,
  type MemoryCandidateV1,
  type MemoryOutboxId,
  type MemoryOutboxPayloadV1,
  type MemoryOutboxV1,
} from "./personal-contracts.js";
import {
  invalid,
  record,
  closed,
  literal,
  text,
  nullableText,
  integer,
  digest,
  nullableDigest,
  prefixedId,
  textList,
} from "./personal-validation-primitives.js";
import { parseConfirmationReceipt, parseDeliveryReceipt } from "./personal-validation-receipts.js";
import { parseBase, finish, common } from "./personal-validation-base.js";

export function parseMemoryCandidateV1(value: unknown): MemoryCandidateV1 {
  const { input, base } = parseBase(value, (item) => prefixedId<MemoryCandidateId>(item, "memcand:pos:v1:"));
  const p = record(input.payload);
  closed(p, [
    "kind",
    "content",
    "content_digest",
    "target_digest",
    "sensitivity",
    "confidence",
    "confirmation_state",
    "confirmation_refs",
    "verification_refs",
    "state",
  ]);
  const kind = literal(p.kind, MEMORY_CANDIDATE_KINDS);
  const content = nullableText(p.content);
  const contentDigest = nullableDigest(p.content_digest);
  const targetDigest = nullableDigest(p.target_digest);
  if ((kind === "forget" && targetDigest === null) || (kind !== "forget" && (content === null || contentDigest === null))) invalid();
  const payload: MemoryCandidatePayloadV1 = {
    kind,
    content,
    content_digest: contentDigest,
    target_digest: targetDigest,
    sensitivity: literal(p.sensitivity, SENSITIVITY_TIERS),
    confidence: literal(p.confidence, MEMORY_CONFIDENCE_STATES),
    confirmation_state: literal(p.confirmation_state, MEMORY_CONFIRMATION_STATES),
    confirmation_refs: textList(p.confirmation_refs),
    verification_refs: textList(p.verification_refs),
    state: literal(p.state, MEMORY_STATES),
  };
  const subjectDigest = contentDigest ?? targetDigest;
  if (subjectDigest === null || base.authority.authority_kind !== "none") invalid();
  const approvedStates = ["approved", "queued", "delivering", "accepted_unsettled", "settled", "uncertain"] as const;
  const approved = approvedStates.some((state) => state === payload.state);
  const sensitive = payload.sensitivity === "sensitive" || payload.sensitivity === "restricted";
  if (payload.state === "awaiting_confirmation" && payload.confirmation_state !== "required") invalid();
  if (
    approved &&
    (payload.confirmation_state === "required" ||
      payload.confirmation_state === "rejected" ||
      (sensitive && payload.confirmation_state !== "confirmed"))
  )
    invalid();
  if (payload.confirmation_state !== "confirmed") {
    if (input.receipt !== null) invalid();
    return finish(common(base, payload, null));
  }
  if (input.receipt === null || !approved) invalid();
  const receipt = parseConfirmationReceipt(input.receipt, base);
  if (
    receipt.candidate_digest !== subjectDigest ||
    receipt.approval.command_digest !== subjectDigest ||
    receipt.approval.decision !== "approve" ||
    !payload.confirmation_refs.includes(receipt.approval.receipt_id)
  )
    invalid();
  return finish(common(base, payload, receipt));
}
export function parseMemoryOutboxV1(value: unknown): MemoryOutboxV1 {
  const { input, base } = parseBase(value, (item) => prefixedId<MemoryOutboxId>(item, "memout:pos:v1:"));
  const p = record(input.payload);
  closed(p, [
    "candidate_id",
    "candidate_digest",
    "operation",
    "provider_version",
    "attempt",
    "fence",
    "expected_artifact_selector",
    "expected_artifact_digest",
    "state",
  ]);
  const payload: MemoryOutboxPayloadV1 = {
    candidate_id: prefixedId<MemoryCandidateId>(p.candidate_id, "memcand:pos:v1:"),
    candidate_digest: digest(p.candidate_digest),
    operation: literal(p.operation, MEMORY_OPERATIONS),
    provider_version: text(p.provider_version, 128),
    attempt: integer(p.attempt, 1, 1_000_000),
    fence: integer(p.fence, 1, 2_147_483_647),
    expected_artifact_selector: text(p.expected_artifact_selector, 512),
    expected_artifact_digest: digest(p.expected_artifact_digest),
    state: literal(p.state, MEMORY_OUTBOX_STATES),
  };
  if (base.authority.authority_kind !== "none") invalid();
  const confirmationStates = ["approved", "queued", "delivering"] as const;
  const deliveryStates = ["accepted_unsettled", "settled", "uncertain"] as const;
  if (confirmationStates.some((state) => state === payload.state)) {
    if (input.receipt === null) invalid();
    const receipt = parseConfirmationReceipt(input.receipt, base);
    if (
      receipt.candidate_digest !== payload.candidate_digest ||
      receipt.approval.command_digest !== payload.candidate_digest ||
      receipt.approval.decision !== "approve"
    )
      invalid();
    return finish(common(base, payload, receipt));
  }
  if (deliveryStates.some((state) => state === payload.state)) {
    if (input.receipt === null) invalid();
    const receipt = parseDeliveryReceipt(input.receipt, base);
    if (
      receipt.candidate_digest !== payload.candidate_digest ||
      receipt.attempt !== payload.attempt ||
      receipt.fence !== payload.fence ||
      receipt.artifact_digest !== payload.expected_artifact_digest ||
      receipt.approval.command_digest !== payload.candidate_digest ||
      receipt.approval.decision !== "approve" ||
      (payload.state === "settled") !== (receipt.reconciled_at !== null)
    )
      invalid();
    return finish(common(base, payload, receipt));
  }
  if (input.receipt !== null) invalid();
  return finish(common(base, payload, null));
}
