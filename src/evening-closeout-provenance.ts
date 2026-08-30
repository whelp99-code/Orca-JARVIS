import type {
  CloseoutCitation,
  CloseoutOmissionReason,
  EveningCloseoutLimits,
} from "./evening-closeout-types.js";

type ProvenanceBudget = {
  readonly sources: Set<string>;
  readonly citations: Set<string>;
  readonly evidence: Set<string>;
};

export function createProvenanceBudget(): ProvenanceBudget {
  return {
    sources: new Set<string>(),
    citations: new Set<string>(),
    evidence: new Set<string>(),
  };
}

export function admitProvenance(
  budget: ProvenanceBudget,
  citations: readonly CloseoutCitation[],
  additionalEvidence: readonly string[],
  limits: EveningCloseoutLimits,
): CloseoutOmissionReason | null {
  const sources = new Set(citations.map(value => value.source_id));
  const citationIds = new Set(citations.map(value => value.citation_id));
  const evidenceIds = new Set([
    ...citations.map(value => value.evidence_id),
    ...additionalEvidence,
  ]);
  const addedSources = [...sources].filter(value => !budget.sources.has(value));
  const addedCitations = [...citationIds].filter(value => !budget.citations.has(value));
  const addedEvidence = [...evidenceIds].filter(value => !budget.evidence.has(value));
  if (budget.sources.size + addedSources.length > limits.max_sources) return "source_cap";
  if (budget.citations.size + addedCitations.length > limits.max_citations) return "citation_cap";
  if (budget.evidence.size + addedEvidence.length > limits.max_evidence) return "evidence_cap";
  for (const value of addedSources) budget.sources.add(value);
  for (const value of addedCitations) budget.citations.add(value);
  for (const value of addedEvidence) budget.evidence.add(value);
  return null;
}

export function createProvenanceFilter(
  limits: EveningCloseoutLimits,
  onOmission: (reason: CloseoutOmissionReason) => void,
) {
  const budget = createProvenanceBudget();
  return <Value extends { readonly citations: readonly CloseoutCitation[] }>(
    values: readonly Value[],
    evidence: (value: Value) => readonly string[] = () => [],
  ): Value[] => values.flatMap(value => {
    const reason = admitProvenance(budget, value.citations, evidence(value), limits);
    if (reason !== null) onOmission(reason);
    return reason === null ? [value] : [];
  });
}
