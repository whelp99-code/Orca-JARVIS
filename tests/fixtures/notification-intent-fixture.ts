import { createHash } from "node:crypto";
import { canonicalize } from "../../src/canonical.js";

export const NOTICE_NOW = "2026-08-28T12:00:00.000Z";
const digest = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;

export function decisionRecord(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const core = {
    semantic_key: "deploy:customer-api",
    recommendation_id: "rec:pos:v1:decision-1",
    action_id: "owner-gated-deploy",
    context_id: "ctx:pos:v1:context-1",
    context_digest: digest("context"),
    recommendation_digest: digest("recommendation"),
    evidence_digest: digest("evidence"),
    identity_digest: digest("identity"),
    source_state: "active",
    trust: "confirmed",
    confidence: "high",
    reversible: true,
    title: "Review protected deployment",
    safety: "standard",
    deadline: "2026-08-28T13:00:00.000Z",
    created_at: "2026-08-28T11:00:00.000Z",
    expires_at: "2026-08-28T13:30:00.000Z",
    priority: {
      owner_safety_gate: "owner_approval_required", customer_impact: "customer_critical", deadline_bucket: "today",
      dependency_blocking: "blocks_customer", irreversible_risk: "low", effort_cost: "low", stable_identity: "deploy-api",
    },
    source_ids: ["src:linux:recommendations"],
    citations: [{ source_id: "src:linux:recommendations", evidence_ref: "live:deploy", evidence_digest: digest("live"),
      observed_at: "2026-08-28T11:00:00.000Z", fresh_until: "2026-08-28T13:30:00.000Z" }],
    events: [{ state: "pending", occurred_at: "2026-08-28T11:00:00.000Z", event_digest: digest("pending") }],
  };
  const merged = { ...core, ...overrides };
  const provenance = { recommendation_id: merged.recommendation_id, action_id: merged.action_id, context_id: merged.context_id,
    context_digest: merged.context_digest, recommendation_digest: merged.recommendation_digest, evidence_digest: merged.evidence_digest,
    identity_digest: merged.identity_digest, source_ids: merged.source_ids, citations: merged.citations, events: merged.events };
  return { ...merged, provenance_digest: digest(provenance), record_digest: digest(merged) };
}

export function decisionInput(items: readonly unknown[]): unknown {
  return { schema_version: 1, generated_at: NOTICE_NOW, items };
}
