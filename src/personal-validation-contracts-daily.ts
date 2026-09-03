import {
  DAILY_LOOP_PHASES,
  DAILY_LOOP_STATES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATES,
  NOTIFICATION_URGENCIES,
  QUIET_HOURS_DECISIONS,
  type ContextId,
  type DailyLoopPayloadV1,
  type DailyLoopRunId,
  type DailyLoopRunV1,
  type NotificationIntentId,
  type NotificationIntentV1,
  type NotificationPayloadV1,
  type RecommendationId,
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
  nullableTimestamp,
  prefixedId,
  textList,
} from "./personal-validation-primitives.js";
import { parseCommandReceipt, bindApproval } from "./personal-validation-receipts.js";
import { parseBase, finish, nullableFamilyId, common } from "./personal-validation-base.js";

export function parseDailyLoopRunV1(value: unknown): DailyLoopRunV1 {
  const { input, base } = parseBase(value, (item) => prefixedId<DailyLoopRunId>(item, "wfr:pos:v1:"));
  const p = record(input.payload);
  closed(p, [
    "loop_date",
    "phase",
    "state",
    "recommendation_id",
    "context_id",
    "request_id",
    "command_digest",
    "lease_owner",
    "lease_fence",
    "lease_expires_at",
    "verification_refs",
  ]);
  const loopDate = text(p.loop_date, 10);
  if (!/^\d{4}-\d\d-\d\d$/.test(loopDate) || new Date(`${loopDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== loopDate) invalid();
  const leaseExpires = nullableTimestamp(p.lease_expires_at);
  const leaseOwner = nullableText(p.lease_owner);
  const fence = integer(p.lease_fence, 0, 2_147_483_647);
  if (
    (leaseOwner === null) !== (leaseExpires === null) ||
    (leaseOwner === null && fence !== 0) ||
    (leaseExpires !== null && Date.parse(leaseExpires) > Date.parse(base.expires_at))
  )
    invalid();
  const payload: DailyLoopPayloadV1 = {
    loop_date: loopDate,
    phase: literal(p.phase, DAILY_LOOP_PHASES),
    state: literal(p.state, DAILY_LOOP_STATES),
    recommendation_id: nullableFamilyId(p.recommendation_id, (item) => prefixedId<RecommendationId>(item, "rec:pos:v1:")),
    context_id: nullableFamilyId(p.context_id, (item) => prefixedId<ContextId>(item, "ctx:pos:v1:")),
    request_id: nullableText(p.request_id),
    command_digest: nullableDigest(p.command_digest),
    lease_owner: leaseOwner,
    lease_fence: fence,
    lease_expires_at: leaseExpires,
    verification_refs: textList(p.verification_refs),
  };
  const authorityStates = ["approved", "claimed", "running", "verifying", "completed", "uncertain", "cancelled"] as const;
  const leaseStates = ["claimed", "running", "verifying", "completed", "uncertain"] as const;
  const requiresAuthority =
    authorityStates.some((state) => state === payload.state) ||
    ((payload.state === "blocked" || payload.state === "failed") && payload.request_id !== null);
  const requiresLease = leaseStates.some((state) => state === payload.state) || (payload.state === "failed" && payload.request_id !== null);
  if (payload.state === "waiting_approval" && (payload.request_id === null || payload.command_digest === null)) invalid();
  if (payload.state === "completed" && payload.verification_refs.length === 0) invalid();
  if (
    requiresLease !== (leaseOwner !== null && leaseExpires !== null && fence > 0) ||
    (!requiresLease && (leaseOwner !== null || leaseExpires !== null || fence !== 0))
  )
    invalid();
  if (!requiresAuthority) {
    if (
      base.authority.authority_kind !== "none" ||
      input.receipt !== null ||
      (payload.state !== "waiting_approval" && (payload.request_id !== null || payload.command_digest !== null))
    )
      invalid();
    return finish(common(base, payload, null));
  }
  const commandDigest = digest(payload.command_digest);
  if (payload.request_id === null) invalid();
  if (input.receipt === null) invalid();
  const receipt = parseCommandReceipt(input.receipt, base.created_at, base.expires_at);
  bindApproval(base, receipt, commandDigest);
  if (
    receipt.request_id !== payload.request_id ||
    receipt.decision !== "approve" ||
    (leaseExpires !== null && Date.parse(leaseExpires) > Date.parse(receipt.expires_at))
  )
    invalid();
  return finish(common(base, payload, receipt));
}
export function parseNotificationIntentV1(value: unknown): NotificationIntentV1 {
  const { input, base } = parseBase(value, (item) => prefixedId<NotificationIntentId>(item, "ntf:pos:v1:"));
  const p = record(input.payload);
  closed(p, ["title", "summary", "alert_class", "urgency", "quiet_hours_decision", "channel", "deep_link", "dedup_key", "state"]);
  const payload: NotificationPayloadV1 = {
    title: text(p.title, 256),
    summary: text(p.summary, 1024),
    alert_class: text(p.alert_class, 128),
    urgency: literal(p.urgency, NOTIFICATION_URGENCIES),
    quiet_hours_decision: literal(p.quiet_hours_decision, QUIET_HOURS_DECISIONS),
    channel: literal(p.channel, NOTIFICATION_CHANNELS),
    deep_link: text(p.deep_link, 512),
    dedup_key: text(p.dedup_key, 256),
    state: literal(p.state, NOTIFICATION_STATES),
  };
  if (!payload.deep_link.startsWith("jarvis://") || input.receipt !== null) invalid();
  return finish(common(base, payload, null));
}
