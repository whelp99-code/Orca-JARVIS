import { createHash } from "node:crypto";
import { canonicalize } from "../../src/canonical.js";
import type { MorningBriefRecord } from "../../src/morning-brief-types.js";

type Payload = Omit<MorningBriefRecord, "provenance_digest" | "canonical_digest">;
const hash = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
export function morningRecord(overrides: Partial<Payload> = {}): MorningBriefRecord {
  const payload: Payload = {
    item_id: "item-1", recommendation_id: "rec-1", action_id: "action-1", semantic_key: "review-release",
    kind: "action", state: "actionable", copy: "Review the cited release", source_ids: ["source-1"],
    citations: [{ link_id: "link-1", source_id: "source-1", evidence_ref: "evidence-1" }],
    observed_at: "2026-08-28T11:59:00.000Z", valid_from: "2026-08-28T11:59:00.000Z",
    valid_until: "2026-08-28T13:00:00.000Z", fresh_until: "2026-08-28T13:00:00.000Z",
    trust: "confirmed", confidence: "high", owner_decision_required: true, deadline: null,
    priority: { owner_safety_gate: "owner_approval_required", customer_impact: "internal", deadline_bucket: "none",
      dependency_blocking: "non_blocking", irreversible_risk: "low", effort_cost: "low", stable_identity: "release" },
    ...overrides,
  };
  const provenance = { item_id: payload.item_id, recommendation_id: payload.recommendation_id, action_id: payload.action_id,
    source_ids: payload.source_ids, citations: payload.citations, observed_at: payload.observed_at,
    valid_from: payload.valid_from, valid_until: payload.valid_until, fresh_until: payload.fresh_until };
  return { ...payload, provenance_digest: hash(provenance), canonical_digest: hash(payload) };
}
export function morningInput(items: readonly MorningBriefRecord[]) {
  return { schema_version: 1, generated_at: "2026-08-28T12:00:00.000Z", context_readiness: "ready",
    external_intelligence: { enabled: false, state: "off" }, limits: null, items };
}
