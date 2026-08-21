import { EvolutionEngineError, scoreEvaluation } from "./evolution-contracts.js";
import type {
  CandidateEvaluator,
  CandidateExecutor,
  CandidateProfile,
  CandidateResult,
  ConsensusResult,
  EngineTask,
  Evaluation,
  ImprovementProposal,
} from "./evolution-contracts.js";

export type ExecutionPath = "fast" | "slow" | "lab";

export interface PerformanceRecord {
  readonly taskKey: string;
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly runs: number;
  readonly successes: number;
  readonly avgScore: number;
  readonly avgCost: number;
  readonly avgLatencyMs: number;
  readonly updatedAt: string;
}

export interface PerformanceMemory {
  list(taskKey: string): readonly PerformanceRecord[];
  champion(taskKey: string, policy: RoutingPolicy): PerformanceRecord | undefined;
  record(taskKey: string, result: CandidateResult, evaluation: Evaluation, success: boolean, now?: Date): PerformanceRecord;
  recordFailure(taskKey: string, result: CandidateResult, now?: Date): PerformanceRecord;
  seed(record: PerformanceRecord): void;
}

export interface RoutingPolicy {
  readonly championMinRuns: number;
  readonly championMinScore: number;
  readonly challengerSampleRate: number;
  readonly maxNormalCandidates: number;
  readonly maxSlowCandidates: number;
  readonly maxLabCandidates: number;
  readonly maxEvaluationCost: number;
  readonly maxEvaluationLatencyMs: number;
  readonly driftScoreDrop: number;
}

export interface BudgetedTask extends EngineTask {
  readonly taskKey: string;
  readonly novelty?: number;
  readonly risk?: "low" | "medium" | "high";
  readonly forceLab?: boolean;
}

export interface RoutingDecision {
  readonly path: ExecutionPath;
  readonly reason: string;
  readonly championId?: string;
  readonly candidateIds: readonly string[];
}

export interface BudgetedRunResult {
  readonly taskId: string;
  readonly decision: RoutingDecision;
  readonly results: readonly CandidateResult[];
  readonly evaluations: readonly Evaluation[];
  readonly consensus: ConsensusResult;
  readonly improvementProposals: readonly ImprovementProposal[];
  readonly evaluationCost: number;
  readonly evaluationLatencyMs: number;
}

export interface CheapVerification {
  readonly passed: boolean;
  readonly reason?: string;
}

export type CheapVerifier = (
  result: CandidateResult,
  task: BudgetedTask,
) => Promise<CheapVerification>;

export type ImprovementGenerator = (input: {
  readonly task: BudgetedTask;
  readonly consensus: ConsensusResult;
  readonly results: readonly CandidateResult[];
}) => Promise<ImprovementProposal[]>;

export interface BudgetedEvolutionDependencies {
  readonly candidates: readonly CandidateProfile[];
  readonly memory: PerformanceMemory;
  readonly executeCandidate: CandidateExecutor;
  readonly evaluateCandidate: CandidateEvaluator;
  readonly cheapVerifier: CheapVerifier;
  readonly policy?: RoutingPolicy;
  readonly generateImprovements?: ImprovementGenerator;
  readonly random?: () => number;
}

export class InMemoryPerformanceMemory implements PerformanceMemory {
  private readonly records = new Map<string, PerformanceRecord>();

  private key(taskKey: string, candidateId: string, fingerprint: string): string {
    return `${taskKey}::${candidateId}::${fingerprint}`;
  }

  list(taskKey: string): PerformanceRecord[] {
    return [...this.records.values()].filter(record => record.taskKey === taskKey);
  }

  champion(taskKey: string, policy: RoutingPolicy): PerformanceRecord | undefined {
    return this.list(taskKey)
      .filter(record => record.runs >= policy.championMinRuns && record.avgScore >= policy.championMinScore)
      .sort((a, b) => b.avgScore - a.avgScore || a.avgCost - b.avgCost || a.avgLatencyMs - b.avgLatencyMs)[0];
  }

  record(taskKey: string, result: CandidateResult, evaluation: Evaluation, success: boolean, now = new Date()): PerformanceRecord {
    const fingerprint = result.candidateFingerprint;
    if (!fingerprint) throw new EvolutionEngineError("ENGINE_RESULT_IDENTITY_MISMATCH");
    const key = this.key(taskKey, result.candidateId, fingerprint);
    const prior = this.records.get(key);
    const runs = (prior?.runs ?? 0) + 1;
    const previousRuns = prior?.runs ?? 0;
    const score = scoreEvaluation(evaluation);
    const cost = result.cost ?? 0;
    const latency = result.latencyMs ?? 0;
    const next: PerformanceRecord = {
      taskKey,
      candidateId: result.candidateId,
      candidateFingerprint: fingerprint,
      runs,
      successes: (prior?.successes ?? 0) + (success ? 1 : 0),
      avgScore: (((prior?.avgScore ?? 0) * previousRuns) + score) / runs,
      avgCost: (((prior?.avgCost ?? 0) * previousRuns) + cost) / runs,
      avgLatencyMs: (((prior?.avgLatencyMs ?? 0) * previousRuns) + latency) / runs,
      updatedAt: now.toISOString(),
    };
    this.records.set(key, next);
    return next;
  }

  recordFailure(taskKey: string, result: CandidateResult, now = new Date()): PerformanceRecord {
    return this.record(
      taskKey,
      result,
      { candidateId: result.candidateId, quality: 0, safety: 0, efficiency: 0 },
      false,
      now,
    );
  }

  seed(record: PerformanceRecord): void {
    this.records.set(this.key(record.taskKey, record.candidateId, record.candidateFingerprint), record);
  }
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  championMinRuns: 3,
  championMinScore: 0.8,
  challengerSampleRate: 0.03,
  maxNormalCandidates: 1,
  maxSlowCandidates: 2,
  maxLabCandidates: 3,
  maxEvaluationCost: 1,
  maxEvaluationLatencyMs: 30_000,
  driftScoreDrop: 0.15,
};
