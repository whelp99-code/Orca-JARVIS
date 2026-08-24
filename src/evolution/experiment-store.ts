import { JarvisError } from "../db.js";

export type Experiment = {
  readonly id: string;
  readonly candidateId: string;
  readonly dataset: string;
  readonly seed: string;
  readonly evaluator: string;
  readonly verifier: string;
  readonly policy: string;
  readonly budget: number;
  readonly generation: string;
};

export type ExperimentMetrics = {
  readonly quality: number;
  readonly cost: number;
  readonly latency: number;
  readonly runs: number;
};

export class ExperimentStore {
  private readonly experiments = new Map<string, Experiment>();
  private readonly metrics = new Map<string, ExperimentMetrics>();

  commit(experiment: Experiment): void {
    if (experiment.evaluator === experiment.candidateId) throw new JarvisError("EVOLUTION_SELF_EVAL");
    if (this.experiments.has(experiment.id)) throw new JarvisError("EVOLUTION_EXPERIMENT_IMMUTABLE");
    this.experiments.set(experiment.id, experiment);
  }

  record(experimentId: string, metrics: ExperimentMetrics): void {
    if (!this.experiments.has(experimentId)) throw new JarvisError("EVOLUTION_EXPERIMENT_UNKNOWN");
    if (!Number.isFinite(metrics.cost)) throw new JarvisError("EVOLUTION_HIDDEN_COST");
    this.metrics.set(experimentId, metrics);
  }

  get(id: string): Experiment {
    const item = this.experiments.get(id);
    if (!item) throw new JarvisError("EVOLUTION_EXPERIMENT_UNKNOWN");
    return item;
  }

  metricsOf(id: string): ExperimentMetrics {
    const item = this.metrics.get(id);
    if (!item) throw new JarvisError("EVOLUTION_METRICS_MISSING");
    return item;
  }
}
