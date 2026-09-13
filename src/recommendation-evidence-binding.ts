import type Database from "better-sqlite3";
import type { Sha256Digest } from "./personal-contracts.js";
import { persistenceRow, persistenceText } from "./personal-persistence-values.js";
import { citationAuthorityForContext, type AssembledCitationKind } from "./personal-context-citation-contract.js";
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
] as const satisfies readonly (readonly [keyof PriorityCitations, RecommendationEvidenceKind,
  AssembledCitationKind | "owner_decision" | null])[];

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
function sha256(candidate: string): candidate is Sha256Digest { return /^sha256:[0-9a-f]{64}$/.test(candidate); }
type OrdinaryLinkInput = {
  readonly database: Database.Database;
  readonly contextId: string;
  readonly reference: string;
  readonly kind: RecommendationEvidenceKind;
};
/**
 * The context row a licensed reference points at. The stored `evidence_kind` is deliberately not
 * read back: it records the role a piece played in assembly, and asking it for a citation licence
 * is exactly the substitution the citation contract exists to refuse. The licence has already been
 * derived from the piece's own source; what remains is to bind the one row it names.
 */
function ordinaryLink(input: OrdinaryLinkInput): RecommendationEvidenceLink {
  const values = input.database.prepare(
    `SELECT m.evidence_id,m.evidence_digest
     FROM personal_context_memory_evidence m
     JOIN personal_context_evidence e ON e.context_id=m.context_id AND e.evidence_id=m.evidence_id
     WHERE m.context_id=? AND m.memory_ref=?
     UNION ALL
     SELECT e.evidence_id,e.evidence_digest
     FROM personal_context_observations o
     JOIN personal_context_evidence e ON e.context_id=o.context_id AND e.position=o.position
     WHERE o.context_id=? AND o.observation_id=?`,
  ).all(input.contextId, input.reference, input.contextId, input.reference);
  if (values.length !== 1) return fail();
  const value = values[0];
  if (value === undefined) return fail();
  const row = persistenceRow(value);
  const digest = persistenceText(row["evidence_digest"]);
  if (!sha256(digest)) return fail();
  return { ref: input.reference, kind: input.kind, context_evidence_id: persistenceText(row["evidence_id"]), digest };
}

/**
 * An owner decision is an authority receipt, not assembled evidence. The assembler never produces
 * one, so a context row carrying the string `owner_decision` beside a reference proves nothing at
 * all - which is why the citation contract refuses to grant that licence from a context. The
 * control plane is the only place that can answer: an approved, unrevoked receipt signed by a
 * trusted decision key. The link then carries the digest of the command the owner actually
 * approved and no context evidence, exactly as the policy slot does.
 */
export function approvedOwnerDecisionDigest(database: Database.Database, reference: string): Sha256Digest | undefined {
  const value = database.prepare(
    `SELECT r.command_digest AS command_digest
     FROM control_command_requests r
     JOIN control_command_receipts a ON a.request_id=r.request_id AND a.decision='approve'
       AND a.command_digest=r.command_digest
     JOIN trusted_authority_keys k ON k.key_id=a.key_id AND k.principal_id=a.signer_principal_id
     JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='decision'
     WHERE r.request_id=? AND r.state IN ('approved','claimed','completed')
       AND NOT EXISTS(SELECT 1 FROM control_command_revocations v
         WHERE v.request_id=r.request_id OR v.receipt_id=a.receipt_id)`,
  ).get(reference);
  if (value === undefined) return undefined;
  const digest = persistenceText(persistenceRow(value)["command_digest"]);
  return sha256(digest) ? digest : undefined;
}
function ownerDecisionLink(database: Database.Database, reference: string,
  kind: RecommendationEvidenceKind): RecommendationEvidenceLink {
  const digest = approvedOwnerDecisionDigest(database, reference);
  if (digest === undefined) return fail();
  return { ref: reference, kind, context_evidence_id: null, digest };
}

type EvidenceBindingInput = {
  readonly database: Database.Database;
  readonly contextId: string;
  readonly contextDigest: Sha256Digest;
  readonly result: PriorityEngineResult;
  readonly actions: readonly PriorityActionDecision[];
  readonly supplied: readonly RecommendationEvidenceLink[];
};
/**
 * The links a ranking requires, derived from what the database can back. A producer builds the
 * links it will supply with this; the consumption boundary derives them again and compares, so
 * nothing a producer states is taken on trust.
 */
export function recommendationEvidenceLinks(
  input: Omit<EvidenceBindingInput, "supplied">,
): readonly RecommendationEvidenceLink[] {
  // The stored kind says what role a piece played in assembly. Whether it may be cited is a
  // different question, and only its own source answers it - so the licence is derived here rather
  // than read from the string beside the evidence.
  const authority = citationAuthorityForContext(input.database, input.contextId);
  const granted = new Map(authority.citable.map(item => [item.reference, item.citation_kind]));
  const links = new Map<string, RecommendationEvidenceLink>();
  for (const action of input.actions) {
    for (const [slot, kind, evidenceKind] of CITATION_SLOTS) {
      const reference = action.rationale.citations[slot];
      if (reference === null) continue;
      const link = evidenceKind === null
        ? policyReference(input.result, reference)
          ? { ref: reference, kind, context_evidence_id: null, digest: input.contextDigest }
          : fail()
        : evidenceKind === "owner_decision"
          ? ownerDecisionLink(input.database, reference, kind)
          : granted.get(reference) === evidenceKind
            ? ordinaryLink({ database: input.database, contextId: input.contextId, reference, kind })
            : fail();
      links.set(reference, link);
    }
  }
  return [...links.values()];
}

export function deriveRecommendationEvidenceLinks(input: EvidenceBindingInput): readonly RecommendationEvidenceLink[] {
  const expected = recommendationEvidenceLinks(input);
  if (!exact(input.supplied, expected)) return fail();
  return expected;
}
