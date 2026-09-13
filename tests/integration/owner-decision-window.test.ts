import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { produceDailyRecommendation, type DailyRecommendationRequest } from "../../src/personal-context-production.js";
import {
  admitLocalChainObservation, approveLocalChainOwnerDecisions, localChainConfirmedMemory,
  persistLocalChainLiveObservation, LOCAL_CHAIN_AT, LOCAL_CHAIN_PRINCIPLE_REF,
} from "../fixtures/local-observation-chain.js";
import { approveFixtureOwnerDecision } from "../fixtures/fixture-authority.js";
import { priorityPolicyConfig } from "../fixtures/priority-engine-input.js";
import { tempDb } from "../helpers.js";

const AT = LOCAL_CHAIN_AT;
// Ninety days before this morning. The owner approved something then; the receipt they signed was
// good for ten minutes.
const LONG_AGO = new Date(Date.parse(AT) - 90 * 86_400_000).toISOString();
const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

function request(observations: readonly unknown[], memory: unknown, ownerImportRef: string,
  ownerGateRef: string, currentRef: string): DailyRecommendationRequest {
  return {
    assemble: { purpose: "daily_prioritization", query: "What should happen next?", clock: AT,
      expires_in_ms: 240_000, budgets: { max_items: 16, max_excerpt_bytes: 512, max_total_bytes: 8192 },
      observations, pending_authority_refs: [], memories: [memory] } as never,
    policy: priorityPolicyConfig(), policy_decision_ref: "policy:linux:personal-os-policy-v1:task17",
    principle_ref: LOCAL_CHAIN_PRINCIPLE_REF, owner_import_decision_ref: ownerImportRef,
    candidates: [{ action_id: "expiry-followup", execution_mode: "jarvis",
      owner_safety_gate: "owner_approval_required", owner_gate_ref: ownerGateRef,
      customer_impact: "customer_critical", deadline: null, dependency: { kind: "non_blocking" },
      irreversible_risk: "low", effort_cost: "medium", principle_ref: LOCAL_CHAIN_PRINCIPLE_REF,
      current_evidence_ref: currentRef, stable_identity: { key: "expiry-followup", evidence_ref: currentRef } }],
    recommendation: { id: "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7c01",
      idempotency_key: `idem:pos:v1:recommendation:${"b".repeat(64)}`,
      correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
      expires_at: "2026-08-28T12:03:00.000Z", confidence_class: "high",
      actions: [{ action_id: "expiry-followup", title: "Next: expiry-followup", operation: "review",
        target_digest: `sha256:${"a".repeat(64)}` }] },
  };
}

/**
 * An approval the owner signed months ago is not an approval for this morning.
 *
 * The receipt states its own window - a command approval may live at most fifteen minutes - and the
 * request it decides states one too. A production run that reads only "approved, not revoked" would
 * let a decision from another season authorize today's work.
 */
it("withholds when the owner's decision is long past its own window", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const { observation } = await admitLocalChainObservation(db);
  const live = persistLocalChainLiveObservation(db);
  const current = approveLocalChainOwnerDecisions(db);
  const stale = approveFixtureOwnerDecision(db, "req:local-chain:gate:expired", LONG_AGO);

  const produced = produceDailyRecommendation(db, request([observation, live.observation],
    localChainConfirmedMemory(db), current.importDecision.request_id, stale.request_id, live.id));

  expect(produced.state).toBe("abstained");
  if (produced.state !== "abstained") throw new TypeError("abstention expected");
  expect(produced.reasons).toEqual(["PRIORITY_OWNER_APPROVAL_REQUIRED"]);
  expect(Number(db.db.prepare("SELECT COUNT(*) FROM personal_recommendations").pluck().get())).toBe(0);
}, 60_000);
