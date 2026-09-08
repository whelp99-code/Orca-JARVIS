import type { AuthorityDb } from "../../src/db.js";
import { Recommendations } from "../../src/recommendations.js";
import { morningInput, morningRecord } from "./morning-brief-record.js";
import { persistTask18Context, RECOMMENDATION_NOW, task18Request } from "./recommendation-fixture.js";

// A contract fixture for shared identifiers, not an operational recommendation-to-brief policy.
export function morningRecommendationProvenance(db: AuthorityDb) {
  const context = persistTask18Context(db);
  const service = new Recommendations(db); service.create(task18Request(context));
  const projection = service.project(RECOMMENDATION_NOW);
  const items = projection.next_actions.map(action => {
    const citations = action.evidence_links.flatMap(link => {
      const evidence = context.evidence.find(item => item.evidence_id === link.context_evidence_id);
      return evidence === undefined ? [] : [{ link_id: evidence.evidence_id, source_id: evidence.source_id, evidence_ref: link.ref }];
    });
    return morningRecord({
      item_id: `brief-input:${action.recommendation_id}:${action.rank}`,
      recommendation_id: action.recommendation_id, action_id: `${action.recommendation_id}:rank:${action.rank}`,
      semantic_key: action.target_digest, copy: action.title, source_ids: [...new Set(citations.map(c => c.source_id))], citations,
      owner_decision_required: action.owner_decision_required, confidence: action.confidence_class,
      observed_at: context.observed_at, valid_from: context.valid_at, valid_until: action.expires_at, fresh_until: action.expires_at,
    });
  });
  return { projection, input: { ...morningInput(items), context_readiness: "degraded" } };
}
