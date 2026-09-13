import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { MorningRecommendationSource } from "../../src/morning-recommendation-source.js";
import { produceDailyRecommendation, type DailyRecommendationRequest } from "../../src/personal-context-production.js";
import { projectRecommendations } from "../../src/recommendation-projection.js";
import {
  admitLocalChainObservation, approveLocalChainOwnerDecisions, localChainConfirmedMemory,
  persistLocalChainLiveObservation, LOCAL_CHAIN_AT, LOCAL_CHAIN_MEMORY_TARGET, LOCAL_CHAIN_PRINCIPLE_REF,
} from "../fixtures/local-observation-chain.js";
import { priorityPolicyConfig } from "../fixtures/priority-engine-input.js";
import { tempDb } from "../helpers.js";

const AT = LOCAL_CHAIN_AT;
const POLICY_REF = "policy:linux:personal-os-policy-v1:task17";
const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

function candidate(currentRef: string, ownerGateRef: string): Record<string, unknown> {
  return { action_id: "produced-followup", execution_mode: "jarvis",
    owner_safety_gate: "owner_approval_required", owner_gate_ref: ownerGateRef,
    customer_impact: "customer_critical", deadline: null, dependency: { kind: "non_blocking" },
    irreversible_risk: "low", effort_cost: "medium", principle_ref: LOCAL_CHAIN_PRINCIPLE_REF,
    current_evidence_ref: currentRef, stable_identity: { key: "produced-followup", evidence_ref: currentRef } };
}

function request(observations: readonly unknown[], candidates: readonly Record<string, unknown>[],
  ownerImportRef: string): DailyRecommendationRequest {
  return {
    assemble: { purpose: "daily_prioritization", query: "What should happen next?", clock: AT,
      expires_in_ms: 240_000, budgets: { max_items: 16, max_excerpt_bytes: 512, max_total_bytes: 8192 },
      observations, pending_authority_refs: [], memories: [localChainConfirmedMemory] } as never,
    policy: priorityPolicyConfig(), policy_decision_ref: POLICY_REF,
    principle_ref: LOCAL_CHAIN_PRINCIPLE_REF, owner_import_decision_ref: ownerImportRef,
    candidates,
    recommendation: { id: "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7a01",
      idempotency_key: `idem:pos:v1:recommendation:${"e".repeat(64)}`,
      correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
      expires_at: "2026-08-28T12:03:00.000Z", confidence_class: "high",
      actions: [{ action_id: "produced-followup", title: "Next: produced-followup",
        operation: "review", target_digest: `sha256:${"a".repeat(64)}` }] },
  };
}

// A local task-timeline collection reports what a cache held. It is not a current Linux fact, so the
// action that would rest on one is withheld and the production path records the abstention rather
// than a recommendation - and the brief says exactly that.
it("abstains through the real production path when only an advisory local source is available", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const { observation } = await admitLocalChainObservation(db);
  const owner = approveLocalChainOwnerDecisions(db);

  const produced = produceDailyRecommendation(db,
    request([observation], [candidate(observation.id, owner.ownerGate.request_id)], owner.importDecision.request_id));

  expect(produced.state).toBe("abstained");
  if (produced.state !== "abstained") throw new TypeError("abstention expected");
  // Nothing the context holds can stand as a current Linux fact, so the policy withholds before a
  // single action is ranked - an earlier refusal than a citation missing from one candidate.
  expect(produced.reasons).toEqual(["PRIORITY_CONTEXT_POLICY_ABSTAINED"]);
  expect(produced.stored.observation_count).toBe(1);
  expect(Number(db.db.prepare("SELECT COUNT(*) FROM personal_recommendations").pluck().get())).toBe(0);
  expect(projectRecommendations(db, AT).next_actions).toEqual([]);
  // Nothing was recorded, so the brief has no source at all rather than one it had to exclude.
  expect(new MorningRecommendationSource(db).generate(AT).brief.abstention_reasons).toEqual(["no_data"]);
});

// With a verified live Linux fact, a confirmed principle and the owner's own approvals on record,
// the same path assembles, persists, ranks and records a recommendation the brief can carry.
it("assembles, persists and records a recommendation when live and owner evidence exist", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const { observation } = await admitLocalChainObservation(db);
  const live = persistLocalChainLiveObservation(db);
  const owner = approveLocalChainOwnerDecisions(db);

  const produced = produceDailyRecommendation(db, request([observation, live.observation],
    [candidate(live.id, owner.ownerGate.request_id)], owner.importDecision.request_id));

  expect(produced.state).toBe("recommended");
  if (produced.state !== "recommended") throw new TypeError("recommendation expected");
  expect(produced.stored.observation_count).toBe(2);
  expect(produced.created.recommendation.payload.context_id).toBe(produced.context.id);
  expect(produced.created.recommendation.payload.state).toBe("eligible");
  expect(projectRecommendations(db, AT).next_actions.map(item => item.title))
    .toEqual(["Next: produced-followup"]);

  new MemoryProjectionAuthority(db).bind({ kind: "context", id: produced.context.id,
    component_id: produced.context.id }, [{ target_digest: LOCAL_CHAIN_MEMORY_TARGET }], new Date(AT));
  const brief = new MorningRecommendationSource(db).generate(AT);
  expect(brief.source.input.items).toHaveLength(1);
  expect(brief.brief.needs_you_first.map(item => item.copy)).toEqual(["Next: produced-followup"]);
});

// An owner gate the owner never decided is not a gate. Everything else about this run is in order -
// a verified live fact, a confirmed principle, the owner's import approval - and the candidate names
// a control request that was never approved. The run has to say so and withhold, not fail after it
// has already written the context it assembled.
it("abstains when a candidate names an owner gate the owner never approved", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const { observation } = await admitLocalChainObservation(db);
  const live = persistLocalChainLiveObservation(db);
  const owner = approveLocalChainOwnerDecisions(db);

  const produced = produceDailyRecommendation(db, request([observation, live.observation],
    [candidate(live.id, "req:local-chain:owner-gate:never-approved")], owner.importDecision.request_id));

  expect(produced.state).toBe("abstained");
  if (produced.state !== "abstained") throw new TypeError("abstention expected");
  // The engine ranked it as needing the owner, and the owner's decision is not on record: that is
  // what the run reports, instead of failing at the binding boundary it would have reached next.
  expect(produced.reasons).toEqual(["PRIORITY_OWNER_APPROVAL_REQUIRED"]);
  expect(Number(db.db.prepare("SELECT COUNT(*) FROM personal_recommendations").pluck().get())).toBe(0);
  expect(projectRecommendations(db, AT).next_actions).toEqual([]);
});
