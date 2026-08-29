import type Database from "better-sqlite3";
import type { Sha256Digest } from "./personal-contracts.js";
import { persistenceRow, persistenceText } from "./personal-persistence-values.js";
import type { PriorityActionDecision, PriorityCitations, PriorityEngineResult } from "./priority-engine.js";
import type { RecommendationEvidenceKind, RecommendationEvidenceLink } from "./recommendation-provenance.js";

const CITATION_SLOTS = [
  ["confirmed_principle_ref", "principle", "user_confirmed_principle"],
  ["confirmed_principle_evidence_ref", "principle", "user_confirmed_principle"],
  ["linux_policy_decision_ref", "policy", null],
  ["owner_import_decision_ref", "owner", "owner_decision"],
  ["current_linux_evidence_ref", "current", "linux_live_fact"],
  ["deadline_evidence_ref", "deadline", "linux_live_fact"],
  ["dependency_evidence_ref", "dependency", "linux_live_fact"],
  ["owner_gate_ref", "owner", "owner_decision"],
  ["stable_identity_evidence_ref", "stable_identity", "linux_live_fact"],
] as const satisfies readonly (readonly [keyof PriorityCitations, RecommendationEvidenceKind, string | null])[];

export class RecommendationEvidenceBindingError extends Error {
  readonly name = "RecommendationEvidenceBindingError";
  constructor() { super("RECOMMENDATION_EVIDENCE_CONFLICT"); }
}
function fail(): never { throw new RecommendationEvidenceBindingError(); }
function exact(left: readonly RecommendationEvidenceLink[], right: readonly RecommendationEvidenceLink[]): boolean {
  return left.length === right.length && left.every((link, index) => {
    const expected = right[index];
    return expected !== undefined && link.ref === expected.ref && link.kind === expected.kind
      && link.context_evidence_id === expected.context_evidence_id && link.digest === expected.digest;
  });
}
function policyReference(result: PriorityEngineResult, reference: string): boolean {
  if (reference !== result.linux_policy_decision_ref) return false;
  const prefix = `policy:linux:${result.policy_id}:`;
  if (!reference.startsWith(prefix)) return false;
  return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(reference.slice(prefix.length));
}
type OrdinaryLinkInput = {
  readonly database: Database.Database;
  readonly contextId: string;
  readonly reference: string;
  readonly kind: RecommendationEvidenceKind;
  readonly evidenceKind: string;
};
function ordinaryLink(input: OrdinaryLinkInput): RecommendationEvidenceLink {
  const values = input.database.prepare(
    `SELECT m.evidence_id,m.evidence_digest,e.evidence_kind
     FROM personal_context_memory_evidence m
     JOIN personal_context_evidence e ON e.context_id=m.context_id AND e.evidence_id=m.evidence_id
     WHERE m.context_id=? AND m.memory_ref=?
     UNION ALL
     SELECT e.evidence_id,e.evidence_digest,e.evidence_kind
     FROM personal_context_observations o
     JOIN personal_context_evidence e ON e.context_id=o.context_id AND e.position=o.position
     WHERE o.context_id=? AND o.observation_id=?`,
  ).all(input.contextId, input.reference, input.contextId, input.reference);
  if (values.length !== 1) return fail();
  const value = values[0];
  if (value === undefined) return fail();
  const row = persistenceRow(value);
  if (persistenceText(row["evidence_kind"]) !== input.evidenceKind) return fail();
  const digest = persistenceText(row["evidence_digest"]);
  function valid(candidate: string): candidate is Sha256Digest { return /^sha256:[0-9a-f]{64}$/.test(candidate); }
  if (!valid(digest)) return fail();
  return { ref: input.reference, kind: input.kind, context_evidence_id: persistenceText(row["evidence_id"]), digest };
}

type EvidenceBindingInput = {
  readonly database: Database.Database;
  readonly contextId: string;
  readonly contextDigest: Sha256Digest;
  readonly result: PriorityEngineResult;
  readonly actions: readonly PriorityActionDecision[];
  readonly supplied: readonly RecommendationEvidenceLink[];
};
export function deriveRecommendationEvidenceLinks(input: EvidenceBindingInput): readonly RecommendationEvidenceLink[] {
  const links = new Map<string, RecommendationEvidenceLink>();
  for (const action of input.actions) {
    for (const [slot, kind, evidenceKind] of CITATION_SLOTS) {
      const reference = action.rationale.citations[slot];
      if (reference === null) continue;
      const link = evidenceKind === null
        ? policyReference(input.result, reference)
          ? { ref: reference, kind, context_evidence_id: null, digest: input.contextDigest }
          : fail()
        : ordinaryLink({ database: input.database, contextId: input.contextId, reference, kind, evidenceKind });
      links.set(reference, link);
    }
  }
  const expected = [...links.values()];
  if (!exact(input.supplied, expected)) return fail();
  return expected;
}
