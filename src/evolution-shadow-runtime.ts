import { scoreEvaluation } from "./evolution-contracts.js";
import type { CandidateResult, Evaluation } from "./evolution-contracts.js";
import type { BudgetedEvolutionEngine, BudgetedRunResult, BudgetedTask, RoutingDecision } from "./budgeted-evolution-engine.js";

export interface ShadowObservation {
  readonly taskId: string;
  readonly decision: RoutingDecision;
  readonly selectedCandidateId: string;
  readonly score: number;
  readonly candidateIds: readonly string[];
  readonly evaluationCost: number;
  readonly evaluationLatencyMs: number;
  readonly createdAt: string;
}

export interface ShadowObservationSink {
  record(observation: ShadowObservation): void | Promise<void>;
}

export interface ShadowRunResult {
  readonly production: CandidateResult;
  readonly shadow?: BudgetedRunResult;
  readonly shadowFailure?: ShadowFailure;
}

export interface ShadowFailure {
  readonly stage: "engine" | "sink";
  readonly message: string;
}

export class EvolutionShadowRuntime {
  constructor(
    private readonly engine: BudgetedEvolutionEngine,
    private readonly productionExecutor: (task: BudgetedTask) => Promise<CandidateResult>,
    private readonly sink?: ShadowObservationSink,
  ) {}

  async run(task: BudgetedTask, now = new Date()): Promise<ShadowRunResult> {
    const production = await this.productionExecutor(task);
    let shadow: BudgetedRunResult;
    try {
      shadow = await this.engine.run(task);
    } catch (error: unknown) {
      if (error instanceof Error) {
        return { production, shadowFailure: { stage: "engine", message: error.message } };
      }
      return { production, shadowFailure: { stage: "engine", message: String(error) } };
    }
    try {
      await this.sink?.record({
        taskId: task.id,
        decision: shadow.decision,
        selectedCandidateId: shadow.consensus.selectedCandidateId,
        score: shadow.consensus.score,
        candidateIds: shadow.decision.candidateIds,
        evaluationCost: shadow.evaluationCost,
        evaluationLatencyMs: shadow.evaluationLatencyMs,
        createdAt: now.toISOString(),
      });
    } catch (error: unknown) {
      if (error instanceof Error) {
        return { production, shadow, shadowFailure: { stage: "sink", message: error.message } };
      }
      return { production, shadow, shadowFailure: { stage: "sink", message: String(error) } };
    }
    return { production, shadow };
  }
}

export const shadowEvaluationSummary = (evaluations: readonly Evaluation[]): { count: number; averageScore: number } => {
  if (evaluations.length === 0) return { count: 0, averageScore: 0 };
  const scores = evaluations.map(scoreEvaluation);
  return { count: scores.length, averageScore: scores.reduce((sum, score) => sum + score, 0) / scores.length };
};
