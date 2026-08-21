import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";

export type CandidateKind = "model" | "agent" | "workflow";

export interface CandidateProfile {
  readonly id: string;
  readonly kind: CandidateKind;
  readonly capabilities: readonly string[];
  readonly costWeight?: number;
  readonly latencyWeight?: number;
  readonly riskWeight?: number;
}

export interface EngineTask {
  readonly id: string;
  readonly objective: string;
  readonly requiredCapabilities: readonly string[];
  readonly context?: unknown;
  readonly budget: {
    readonly maxCandidates: number;
    readonly maxEvolutionRounds: number;
  };
}

export interface CandidateResult {
  readonly candidateId: string;
  readonly candidateFingerprint?: string;
  readonly output: unknown;
  readonly evidence?: unknown;
  readonly latencyMs?: number;
  readonly cost?: number;
}

export interface Evaluation {
  readonly candidateId: string;
  readonly quality: number;
  readonly safety: number;
  readonly efficiency: number;
  readonly rationale?: string;
}

export interface ConsensusResult {
  readonly selectedCandidateId: string;
  readonly selectedOutput: unknown;
  readonly score: number;
  readonly evaluations: readonly Evaluation[];
}

export interface ImprovementProposal {
  readonly id: string;
  readonly targetCandidateId: string;
  readonly reason: string;
  readonly mutation: unknown;
  readonly expectedGain: number;
  readonly requiresApproval: true;
}

export type CandidateExecutor = (
  candidate: CandidateProfile,
  task: EngineTask,
) => Promise<CandidateResult>;

export type CandidateEvaluator = (
  result: CandidateResult,
  task: EngineTask,
) => Promise<Evaluation>;

export type EvolutionEngineErrorCode =
  | "ENGINE_ALL_CANDIDATES_FAILED_VERIFICATION"
  | "ENGINE_EVALUATION_BUDGET_EXHAUSTED"
  | "ENGINE_EVALUATION_MISMATCH"
  | "ENGINE_IMPROVEMENT_MUST_REQUIRE_APPROVAL"
  | "ENGINE_INVALID_BUDGET"
  | "ENGINE_INVALID_METRIC"
  | "ENGINE_NO_CAPABLE_CANDIDATE"
  | "ENGINE_NO_RESULTS"
  | "ENGINE_RESULT_IDENTITY_MISMATCH"
  | "ENGINE_VERIFICATION_MISMATCH";

export class EvolutionEngineError extends Error {
  readonly code: EvolutionEngineErrorCode;

  constructor(code: EvolutionEngineErrorCode) {
    super(code);
    this.name = "EvolutionEngineError";
    this.code = code;
  }
}

const clampScore = (value: number): number => Math.max(0, Math.min(1, value));

export const scoreEvaluation = (evaluation: Evaluation): number =>
  clampScore(evaluation.quality) * 0.6
  + clampScore(evaluation.safety) * 0.3
  + clampScore(evaluation.efficiency) * 0.1;

export const candidateFingerprint = (candidate: CandidateProfile): string => {
  const payload = canonicalize({
    capabilities: [...candidate.capabilities].sort(),
    costWeight: candidate.costWeight ?? 0,
    id: candidate.id,
    kind: candidate.kind,
    latencyWeight: candidate.latencyWeight ?? 0,
    riskWeight: candidate.riskWeight ?? 0,
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
};
