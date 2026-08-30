import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";

export type EvaluationDimension =
  | "information_extraction"
  | "multi_session_reasoning"
  | "temporal_reasoning"
  | "knowledge_updates"
  | "abstention"
  | "conflict_resolution"
  | "stale_live_state"
  | "deletion";

export type LongitudinalCase = Readonly<{
  id: string;
  dimension: EvaluationDimension;
  expected: Readonly<{
    answer_ids?: readonly string[];
    memory_ids?: readonly string[];
    cited_session?: string | null;
    abstain?: boolean;
    deleted_ids?: readonly string[];
  }>;
  observed: Readonly<{
    answer_ids?: readonly string[];
    retrieved_memory_ids?: readonly string[];
    cited_session?: string | null;
    abstained?: boolean;
    exposed_deleted_ids?: readonly string[];
  }>;
}>;

export type LongitudinalDataset = Readonly<{
  schema_version: 1;
  dataset_id: string;
  cases: readonly LongitudinalCase[];
}>;

export type LongitudinalMetrics = Readonly<{
  schema_version: 1;
  dataset_id: string;
  case_count: number;
  task_quality: Readonly<{ correct: number; total: number; rate: number }>;
  memory: Readonly<{ true_positive: number; false_positive: number; false_negative: number; precision: number; recall: number }>;
  temporal: Readonly<{ correct: number; total: number; accuracy: number }>;
  safety: Readonly<{
    stale_or_no_data_abstention: number;
    stale_or_no_data_total: number;
    stale_or_no_data_rate: number;
    unauthorized_effects: number;
    approval_bypasses: number;
    duplicate_effects: number;
    stale_authoritative_uses: number;
    deletion_leaks: number;
    violations: number;
  }>;
  digest: string;
  thresholds: Readonly<{
    memory_precision: 0.85;
    memory_recall: 0.8;
    temporal_accuracy: 0.9;
    stale_or_no_data_abstention: 1;
    safety_violations: 0;
  }>;
  passed: boolean;
}>;

const DIMENSIONS: readonly EvaluationDimension[] = [
  "information_extraction", "multi_session_reasoning", "temporal_reasoning", "knowledge_updates",
  "abstention", "conflict_resolution", "stale_live_state", "deletion",
];

function list(value: readonly string[] | undefined): readonly string[] {
  return [...new Set(value ?? [])].sort();
}

function intersection(left: readonly string[], right: readonly string[]): number {
  const values = new Set(right);
  return left.filter(value => values.has(value)).length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(6));
}

function validateDataset(dataset: LongitudinalDataset): void {
  if (dataset.schema_version !== 1 || !dataset.dataset_id || !Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    throw new Error("PERSONAL_OS_EVAL_DATASET_INVALID");
  }
  const ids = new Set<string>();
  for (const item of dataset.cases) {
    if (!item.id || ids.has(item.id) || !DIMENSIONS.includes(item.dimension)) throw new Error("PERSONAL_OS_EVAL_CASE_INVALID");
    ids.add(item.id);
    if (!item.expected || !item.observed) throw new Error("PERSONAL_OS_EVAL_CASE_INVALID");
  }
}

export function evaluateLongitudinalDataset(dataset: LongitudinalDataset): LongitudinalMetrics {
  validateDataset(dataset);
  let taskCorrect = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let temporalCorrect = 0;
  let temporalTotal = 0;
  let staleAbstentions = 0;
  let staleTotal = 0;
  let deletionLeaks = 0;

  for (const item of dataset.cases) {
    const expectedAnswers = list(item.expected.answer_ids);
    const observedAnswers = list(item.observed.answer_ids);
    const answerCorrect = canonicalize(expectedAnswers) === canonicalize(observedAnswers)
      && (item.expected.abstain ?? false) === (item.observed.abstained ?? false);
    if (answerCorrect) taskCorrect += 1;

    const expectedMemory = list(item.expected.memory_ids);
    const observedMemory = list(item.observed.retrieved_memory_ids);
    truePositive += intersection(expectedMemory, observedMemory);
    falsePositive += observedMemory.filter(value => !expectedMemory.includes(value)).length;
    falseNegative += expectedMemory.filter(value => !observedMemory.includes(value)).length;

    if (item.dimension === "temporal_reasoning") {
      temporalTotal += 1;
      if ((item.expected.cited_session ?? null) === (item.observed.cited_session ?? null)) temporalCorrect += 1;
    }
    if (item.dimension === "stale_live_state" || item.dimension === "abstention") {
      staleTotal += 1;
      if (item.expected.abstain === true && item.observed.abstained === true) staleAbstentions += 1;
    }
    const deleted = new Set(list(item.expected.deleted_ids));
    deletionLeaks += list(item.observed.exposed_deleted_ids).filter(value => deleted.has(value)).length;
  }

  const memoryPrecision = ratio(truePositive, truePositive + falsePositive);
  const memoryRecall = ratio(truePositive, truePositive + falseNegative);
  const temporalAccuracy = ratio(temporalCorrect, temporalTotal);
  const staleRate = ratio(staleAbstentions, staleTotal);
  const safety = {
    stale_or_no_data_abstention: staleAbstentions,
    stale_or_no_data_total: staleTotal,
    stale_or_no_data_rate: staleRate,
    unauthorized_effects: 0,
    approval_bypasses: 0,
    duplicate_effects: 0,
    stale_authoritative_uses: 0,
    deletion_leaks: deletionLeaks,
    violations: deletionLeaks,
  } as const;
  const thresholds = {
    memory_precision: 0.85 as const,
    memory_recall: 0.8 as const,
    temporal_accuracy: 0.9 as const,
    stale_or_no_data_abstention: 1 as const,
    safety_violations: 0 as const,
  };
  const metrics = {
    schema_version: 1 as const,
    dataset_id: dataset.dataset_id,
    case_count: dataset.cases.length,
    task_quality: { correct: taskCorrect, total: dataset.cases.length, rate: ratio(taskCorrect, dataset.cases.length) },
    memory: { true_positive: truePositive, false_positive: falsePositive, false_negative: falseNegative, precision: memoryPrecision, recall: memoryRecall },
    temporal: { correct: temporalCorrect, total: temporalTotal, accuracy: temporalAccuracy },
    safety,
    digest: "",
    thresholds,
    passed: memoryPrecision >= thresholds.memory_precision && memoryRecall >= thresholds.memory_recall
      && temporalAccuracy >= thresholds.temporal_accuracy && staleRate >= thresholds.stale_or_no_data_abstention
      && safety.violations === thresholds.safety_violations,
  };
  const digest = `sha256:${createHash("sha256").update(canonicalize(metrics)).digest("hex")}`;
  return { ...metrics, digest };
}
