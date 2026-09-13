import type { CapabilityProbe } from "./capabilities.js";
import type { AuthorityDb } from "./db.js";
import { projectRecommendations, type RecommendationReadProjection } from "./recommendation-projection.js";
import {
  buildCurrentState as buildBaseCurrentState,
  type CurrentStateOptions,
  type CurrentStateProjection as BaseCurrentStateProjection,
} from "./state-projection.js";

export interface CurrentStateProjection extends BaseCurrentStateProjection {
  recommendations: RecommendationReadProjection;
}
export type { CapabilityProbe, CurrentStateOptions };

export async function buildCurrentState(
  db: AuthorityDb,
  now = new Date(),
  options: CurrentStateOptions = {},
): Promise<CurrentStateProjection> {
  const base = await buildBaseCurrentState(db, now, options);
  const recommendations = projectRecommendations(db, now.toISOString(), 100);
  return {
    ...base,
    decisions: [...recommendations.owner_decisions_needed, ...base.decisions],
    next_3: [...recommendations.next_actions, ...base.next_3].slice(0, 3),
    risks: [...base.risks, ...recommendations.warnings],
    recommendations,
  };
}
