import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { normalizePersonalObservations } from "../../src/personal-observations.js";
import type { OrcaTaskObservationInput } from "../../src/index.js";
import { ObservationRefreshStore } from "../../src/observation-refresh-store.js";
import { produceDailyRecommendation, type DailyRecommendationRequest } from "../../src/personal-context-production.js";
import {
  admitLocalChainObservation, approveLocalChainOwnerDecisions, localChainConfirmedMemory,
  LOCAL_CHAIN_AT, LOCAL_CHAIN_PRINCIPLE_REF,
} from "../fixtures/local-observation-chain.js";
import { approveFixtureOwnerDecision } from "../fixtures/fixture-authority.js";
import { priorityPolicyConfig } from "../fixtures/priority-engine-input.js";
import { tempDb } from "../helpers.js";

const AT = LOCAL_CHAIN_AT;
const TASK = "task:collection-path";
const WORKTREE = "worktree-collection-path";
const SOURCE = "src:pos:v1:orca:local";
const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

/** A structured Orca task timeline, of the shape a collector hands over. */
const liveTask = (): OrcaTaskObservationInput => ({
  environment: "local" as const, worktree: "/home/jm/orca/workspaces/collection-path",
  worktree_id: WORKTREE, terminal_id: "terminal-collection", session_id: "session-collection",
  incarnation_id: "incarnation-collection", pty_id: "pty-collection", cursor: "cursor-collection",
  working: true,
  timeline: { schema_version: 1, generated_at: AT,
    task: { task_id: TASK, title: "not persisted", kind: "work", state: "running",
      updated_at: new Date(Date.parse(AT) - 60_000).toISOString(), pending_approval: false,
      source_ids: ["source-collection"] },
    events: [{ event_id: "evidence-collection", task_id: TASK, source: "verification",
      kind: "evidence", actor: "verifier", title: "not persisted", status: "recorded",
      payload: { fact: "not persisted" }, evidence_refs: ["verify-collection"],
      created_at: new Date(Date.parse(AT) - 60_000).toISOString(), sequence: 1 }],
    pending_decisions: [], workers: [], evidence: [], truncated: false },
});

const normalized = () => {
  const [observation] = normalizePersonalObservations({ checked_at: AT, portfolios: [],
    orca_tasks: [liveTask()] });
  if (observation === undefined) throw new TypeError("live observation required");
  return observation;
};

/** A database holding a confirmed principle, the owner's import decision and a gate for this work. */
async function prepared() {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const { observation } = await admitLocalChainObservation(db);
  const owner = approveLocalChainOwnerDecisions(db);
  const gate = approveFixtureOwnerDecision(db, "req:collection:gate", AT, `task:${TASK}`);
  return { db, local: observation, owner, gate };
}

function request(observations: readonly unknown[], memory: unknown, ownerImportRef: string,
  ownerGateRef: string, currentRef: string): DailyRecommendationRequest {
  return {
    assemble: { purpose: "daily_prioritization", query: "What should happen next?", clock: AT,
      expires_in_ms: 240_000, budgets: { max_items: 16, max_excerpt_bytes: 512, max_total_bytes: 8192 },
      observations, pending_authority_refs: [], memories: [memory] } as never,
    policy: priorityPolicyConfig(), policy_decision_ref: "policy:linux:personal-os-policy-v1:task17",
    principle_ref: LOCAL_CHAIN_PRINCIPLE_REF, owner_import_decision_ref: ownerImportRef,
    candidates: [{ action_id: "collection-followup", execution_mode: "jarvis",
      owner_safety_gate: "owner_approval_required", owner_gate_ref: ownerGateRef,
      customer_impact: "customer_critical", deadline: null, dependency: { kind: "non_blocking" },
      irreversible_risk: "low", effort_cost: "medium", principle_ref: LOCAL_CHAIN_PRINCIPLE_REF,
      current_evidence_ref: currentRef,
      stable_identity: { key: "collection-followup", evidence_ref: currentRef } }],
    recommendation: { id: "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7d01",
      idempotency_key: `idem:pos:v1:recommendation:${"c".repeat(64)}`,
      correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
      expires_at: "2026-08-28T12:03:00.000Z", confidence_class: "high",
      actions: [{ action_id: "collection-followup", title: "Next: collection-followup",
        operation: "review", target_digest: `sha256:${"a".repeat(64)}` }] },
  };
}

const recommendations = (db: AuthorityDb): number =>
  Number(db.db.prepare("SELECT COUNT(*) FROM personal_recommendations").pluck().get());

/**
 * A current Linux fact is a thing this machine went and looked at. The normaliser stamps
 * `trust: "verified"` and `source_kind: "live_adapter"` on any structured task handed to it, because
 * shaping an envelope is all it does; whether anything was actually collected is a different
 * question, and the refresh receipt is where this database answers it.
 */
it("refuses a live fact no collection admitted, and accepts the same task once collected", async () => {
  const fabricated = await prepared();
  const invented = normalized();
  fabricated.db.persistObservation(invented, AT);

  const refused = produceDailyRecommendation(fabricated.db, request([fabricated.local, invented],
    localChainConfirmedMemory(fabricated.db), fabricated.owner.importDecision.request_id,
    fabricated.gate.request_id, String(invented.id)));
  expect(refused.state).toBe("abstained");
  expect(recommendations(fabricated.db)).toBe(0);

  // The same task, this time admitted through the store the collector writes to: scope, collection
  // outcome and timeline consistency all checked, and a receipt naming what was admitted.
  const collected = await prepared();
  new ObservationRefreshStore(collected.db, { members: [{ source_id: SOURCE, worktree_id: WORKTREE }] })
    .admit({ key: "collection-path", capped: false,
      collections: [{ source_id: SOURCE, worktree_id: WORKTREE, state: "completed" }],
      observations: { checked_at: AT, portfolios: [], orca_tasks: [liveTask()] } }, AT);
  const admitted = normalized();

  const produced = produceDailyRecommendation(collected.db, request([collected.local, admitted],
    localChainConfirmedMemory(collected.db), collected.owner.importDecision.request_id,
    collected.gate.request_id, String(admitted.id)));
  expect(produced.state).toBe("recommended");
  expect(recommendations(collected.db)).toBe(1);
}, 60_000);
