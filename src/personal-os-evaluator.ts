import { parsePersonalOsCorpus } from "./personal-os-corpus-parser.js";
import { runPersonalOsCorpus } from "./personal-os-runner.js";
import { scorePersonalOsResults } from "./personal-os-scorer.js";
import type { PersonalOsEvaluationResult } from "./personal-os-eval-types.js";

export { runPersonalOsCorpus } from "./personal-os-runner.js";
export { scorePersonalOsResults } from "./personal-os-scorer.js";

export function evaluatePersonalOsCorpus(value: unknown): PersonalOsEvaluationResult {
  const corpus = parsePersonalOsCorpus(value);
  return scorePersonalOsResults(corpus, runPersonalOsCorpus(corpus));
}
