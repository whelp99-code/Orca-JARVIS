import { JarvisError } from "../db.js";
import type { ExperimentStore } from "./experiment-store.js";

export type PromotionRequest = {
  readonly experimentId: string;
  readonly approved: boolean;
  readonly championExperimentId?: string;
};

export class PromotionGate {
  constructor(private readonly experiments: ExperimentStore, private readonly maxDrift = 0.15, private readonly minChampionRuns = 5) {}

  decide(request: PromotionRequest): "promote" | "refuse" {
    if (!request.approved) throw new JarvisError("EVOLUTION_APPROVAL_REQUIRED");
    const challenger = this.experiments.metricsOf(request.experimentId);
    if (request.championExperimentId) {
      const champion = this.experiments.metricsOf(request.championExperimentId);
      if (champion.runs < this.minChampionRuns) throw new JarvisError("EVOLUTION_LEGACY_CHAMPION");
      if (challenger.quality <= champion.quality) throw new JarvisError("EVOLUTION_NO_GAIN");
      const drift = Math.abs(challenger.quality - champion.quality) / Math.max(champion.quality, 1e-9);
      if (drift > this.maxDrift) throw new JarvisError("EVOLUTION_DRIFT");
    }
    return "promote";
  }
}
