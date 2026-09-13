import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { produceDailyRecommendation, type DailyRecommendationRequest } from "../../src/personal-context-production.js";
import {
  admitLocalChainObservation, approveLocalChainOwnerDecisions, localChainConfirmedMemory,
  localChainDeclaredMemory, persistLocalChainLiveObservation, LOCAL_CHAIN_AT, LOCAL_CHAIN_PRINCIPLE_REF,
} from "../fixtures/local-observation-chain.js";
import { priorityPolicyConfig } from "../fixtures/priority-engine-input.js";
import { tempDb } from "../helpers.js";

const AT = LOCAL_CHAIN_AT;
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
    candidates: [{ action_id: "proof-followup", execution_mode: "jarvis",
      owner_safety_gate: "owner_approval_required", owner_gate_ref: ownerGateRef,
      customer_impact: "customer_critical", deadline: null, dependency: { kind: "non_blocking" },
      irreversible_risk: "low", effort_cost: "medium", principle_ref: LOCAL_CHAIN_PRINCIPLE_REF,
      current_evidence_ref: currentRef, stable_identity: { key: "proof-followup", evidence_ref: currentRef } }],
    recommendation: { id: "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7b01",
      idempotency_key: `idem:pos:v1:recommendation:${"f".repeat(64)}`,
      correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
      expires_at: "2026-08-28T12:03:00.000Z", confidence_class: "high",
      actions: [{ action_id: "proof-followup", title: "Next: proof-followup", operation: "review",
        target_digest: `sha256:${"a".repeat(64)}` }] },
  };
}

/**
 * The licence to rest on a confirmed principle belongs to the confirmation, not to the word beside
 * the memory. Assembly seals what the caller declared - it has nothing else to go on - so a run that
 * produces from those inputs has to ask the control plane before an action rests on one.
 */
it("withholds when the principle is only declared, and produces when it is really confirmed", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const { observation } = await admitLocalChainObservation(db);
  const live = persistLocalChainLiveObservation(db);
  const owner = approveLocalChainOwnerDecisions(db);

  // An arbitrary digest wearing "user_confirmed": this database holds no candidate, decision or
  // receipt behind it.
  const declared = produceDailyRecommendation(db, request([observation, live.observation],
    localChainDeclaredMemory, owner.importDecision.request_id, owner.ownerGate.request_id, live.id));
  expect(declared.state).toBe("abstained");
  if (declared.state !== "abstained") throw new TypeError("abstention expected");
  // The engine's own words for it: the policy withheld, and the principle was not available to
  // cite - which is what an unprovable confirmation amounts to.
  expect(declared.reasons).toEqual(["PRIORITY_CONTEXT_POLICY_ABSTAINED", "PRIORITY_MEMORY_UNAVAILABLE"]);
  expect(Number(db.db.prepare("SELECT COUNT(*) FROM personal_recommendations").pluck().get())).toBe(0);

  // The same run, with a principle the owner really confirmed through the product's own path.
  const confirmed = produceDailyRecommendation(db, request([observation, live.observation],
    localChainConfirmedMemory(db), owner.importDecision.request_id, owner.ownerGate.request_id, live.id));
  expect(confirmed.state).toBe("recommended");
  expect(Number(db.db.prepare("SELECT COUNT(*) FROM personal_recommendations").pluck().get())).toBe(1);
}, 60_000);
