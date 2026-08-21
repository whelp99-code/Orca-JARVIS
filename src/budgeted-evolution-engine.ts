import { candidateFingerprint, EvolutionEngineError, scoreEvaluation } from "./evolution-contracts.js";
import type { CandidateEvaluator, CandidateExecutor, CandidateProfile, CandidateResult, ConsensusResult, Evaluation, ImprovementProposal } from "./evolution-contracts.js";
import { DEFAULT_ROUTING_POLICY } from "./evolution-routing.js";
import type { BudgetedEvolutionDependencies, BudgetedRunResult, BudgetedTask, CheapVerifier, ImprovementGenerator, PerformanceMemory, RoutingDecision, RoutingPolicy } from "./evolution-routing.js";

export { DEFAULT_ROUTING_POLICY, InMemoryPerformanceMemory } from "./evolution-routing.js";
export type { BudgetedEvolutionDependencies, BudgetedRunResult, BudgetedTask, CheapVerification, CheapVerifier, ExecutionPath, ImprovementGenerator, PerformanceMemory, PerformanceRecord, RoutingDecision, RoutingPolicy } from "./evolution-routing.js";

export class BudgetedEvolutionEngine {
  private readonly candidates: readonly CandidateProfile[];
  private readonly memory: PerformanceMemory;
  private readonly executeCandidate: CandidateExecutor;
  private readonly evaluateCandidate: CandidateEvaluator;
  private readonly cheapVerifier: CheapVerifier;
  private readonly policy: RoutingPolicy;
  private readonly generateImprovements?: ImprovementGenerator;
  private readonly random: () => number;

  constructor(dependencies: BudgetedEvolutionDependencies) {
    this.candidates = dependencies.candidates;
    this.memory = dependencies.memory;
    this.executeCandidate = dependencies.executeCandidate;
    this.evaluateCandidate = dependencies.evaluateCandidate;
    this.cheapVerifier = dependencies.cheapVerifier;
    this.policy = dependencies.policy ?? DEFAULT_ROUTING_POLICY;
    this.generateImprovements = dependencies.generateImprovements;
    this.random = dependencies.random ?? Math.random;
  }

  private validateResult(profile: CandidateProfile, result: CandidateResult): void {
    if (result.candidateId !== profile.id) {
      throw new EvolutionEngineError("ENGINE_RESULT_IDENTITY_MISMATCH");
    }
    for (const value of [result.cost, result.latencyMs]) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new EvolutionEngineError("ENGINE_INVALID_METRIC");
      }
    }
  }

  private validateEvaluation(result: CandidateResult, evaluation: Evaluation): void {
    if (evaluation.candidateId !== result.candidateId) {
      throw new EvolutionEngineError("ENGINE_RESULT_IDENTITY_MISMATCH");
    }
    if (![evaluation.quality, evaluation.safety, evaluation.efficiency].every(value => Number.isFinite(value))) {
      throw new EvolutionEngineError("ENGINE_INVALID_METRIC");
    }
  }

  private capable(task: BudgetedTask): CandidateProfile[] {
    const required = new Set(task.requiredCapabilities);
    return this.candidates
      .map(candidate => {
        const matched = candidate.capabilities.filter(capability => required.has(capability)).length;
        const coverage = required.size === 0 ? 1 : matched / required.size;
        const score = coverage * 4 - (candidate.costWeight ?? 0) - (candidate.latencyWeight ?? 0) - (candidate.riskWeight ?? 0);
        return { candidate, coverage, score };
      })
      .filter(item => item.coverage === 1)
      .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))
      .map(item => item.candidate);
  }

  decide(task: BudgetedTask): RoutingDecision {
    if (!Number.isInteger(task.budget.maxCandidates) || task.budget.maxCandidates < 1) {
      throw new EvolutionEngineError("ENGINE_INVALID_BUDGET");
    }
    const capable = this.capable(task);
    if (capable.length === 0) throw new EvolutionEngineError("ENGINE_NO_CAPABLE_CANDIDATE");
    const known = this.memory.list(task.taskKey);
    const fingerprints = new Map(capable.map(candidate => [candidate.id, candidateFingerprint(candidate)]));
    const champion = known
      .filter(record => fingerprints.get(record.candidateId) === record.candidateFingerprint && record.runs >= this.policy.championMinRuns && record.avgScore >= this.policy.championMinScore)
      .sort((a, b) => b.avgScore - a.avgScore || a.avgCost - b.avgCost || a.avgLatencyMs - b.avgLatencyMs)[0];
    const championCandidate = champion ? capable.find(candidate => candidate.id === champion.candidateId) : undefined;
    const latestChampionRecord = championCandidate ? known.find(record => record.candidateId === championCandidate.id) : undefined;
    const bestHistorical = known.filter(record => fingerprints.get(record.candidateId) === record.candidateFingerprint).sort((a, b) => b.avgScore - a.avgScore)[0];
    const drifted = Boolean(latestChampionRecord && bestHistorical && bestHistorical.avgScore - latestChampionRecord.avgScore >= this.policy.driftScoreDrop);
    const novel = (task.novelty ?? 0) >= 0.7;
    const risky = task.risk === "high";

    if (task.forceLab) {
      const limit = Math.min(task.budget.maxCandidates, this.policy.maxLabCandidates);
      return { path: "lab", reason: "forced_lab", championId: championCandidate?.id, candidateIds: capable.slice(0, limit).map(candidate => candidate.id) };
    }

    if (championCandidate && !novel && !risky && !drifted) {
      const challenger = this.random() < this.policy.challengerSampleRate
        ? capable.find(candidate => candidate.id !== championCandidate.id)
        : undefined;
      if (challenger) {
        const limit = Math.min(task.budget.maxCandidates, this.policy.maxSlowCandidates);
        return { path: "slow", reason: "sampled_challenger", championId: championCandidate.id, candidateIds: [championCandidate.id, challenger.id].slice(0, limit) };
      }
      const limit = Math.min(task.budget.maxCandidates, this.policy.maxNormalCandidates);
      return { path: "fast", reason: "trusted_champion", championId: championCandidate.id, candidateIds: [championCandidate.id].slice(0, limit) };
    }

    const policyLimit = risky ? this.policy.maxLabCandidates : this.policy.maxSlowCandidates;
    const ids = capable.slice(0, Math.min(task.budget.maxCandidates, policyLimit)).map(candidate => candidate.id);
    return { path: risky ? "lab" : "slow", reason: risky ? "high_risk" : drifted ? "drift_detected" : novel ? "novel_task" : "no_trusted_champion", championId: championCandidate?.id, candidateIds: ids };
  }

  private consensus(results: CandidateResult[], evaluations: Evaluation[]): ConsensusResult {
    if (results.length === 0 || evaluations.length === 0) throw new EvolutionEngineError("ENGINE_NO_RESULTS");
    const sorted = evaluations.slice().sort((a, b) => scoreEvaluation(b) - scoreEvaluation(a) || a.candidateId.localeCompare(b.candidateId));
    const winner = sorted[0];
    if (!winner) throw new EvolutionEngineError("ENGINE_NO_RESULTS");
    const selected = results.find(result => result.candidateId === winner.candidateId);
    if (!selected) throw new EvolutionEngineError("ENGINE_EVALUATION_MISMATCH");
    return { selectedCandidateId: selected.candidateId, selectedOutput: selected.output, score: scoreEvaluation(winner), evaluations };
  }

  async run(task: BudgetedTask): Promise<BudgetedRunResult> {
    const decision = this.decide(task);
    const selectedProfiles = decision.candidateIds.map(id => this.candidates.find(candidate => candidate.id === id)).filter((candidate): candidate is CandidateProfile => Boolean(candidate));
    if (selectedProfiles.length === 0) throw new EvolutionEngineError("ENGINE_NO_CAPABLE_CANDIDATE");
    const executed = await Promise.all(selectedProfiles.map(candidate => this.executeCandidate(candidate, task)));
    const results = executed.map((result, index) => {
      const profile = selectedProfiles[index];
      if (!profile) throw new EvolutionEngineError("ENGINE_RESULT_IDENTITY_MISMATCH");
      this.validateResult(profile, result);
      return { ...result, candidateFingerprint: candidateFingerprint(profile) };
    });
    results.forEach((result, index) => {
      const profile = selectedProfiles[index];
      if (!profile) throw new EvolutionEngineError("ENGINE_RESULT_IDENTITY_MISMATCH");
      this.validateResult(profile, result);
    });

    const verifications = await Promise.all(results.map(result => this.cheapVerifier(result, task)));
    const passingResults = results.filter((_, index) => verifications[index]?.passed === true);
    results
      .filter((_, index) => verifications[index]?.passed === false)
      .forEach(result => this.memory.recordFailure(task.taskKey, result));
    if (passingResults.length === 0) throw new EvolutionEngineError("ENGINE_ALL_CANDIDATES_FAILED_VERIFICATION");
    const toEvaluate = passingResults;

    const evaluations: Evaluation[] = [];
    let evaluationCost = 0;
    let evaluationLatencyMs = 0;
    for (const result of toEvaluate) {
      const nextCost = evaluationCost + (result.cost ?? 0);
      const nextLatency = evaluationLatencyMs + (result.latencyMs ?? 0);
      if (nextCost > this.policy.maxEvaluationCost || nextLatency > this.policy.maxEvaluationLatencyMs) {
        if (evaluations.length === 0) throw new EvolutionEngineError("ENGINE_EVALUATION_BUDGET_EXHAUSTED");
        break;
      }
      const evaluation = await this.evaluateCandidate(result, task);
      this.validateEvaluation(result, evaluation);
      evaluations.push(evaluation);
      evaluationCost = nextCost;
      evaluationLatencyMs = nextLatency;
    }

    if (evaluations.length === 0) throw new EvolutionEngineError("ENGINE_EVALUATION_BUDGET_EXHAUSTED");
    const evaluatedResults = results.filter(result => evaluations.some(evaluation => evaluation.candidateId === result.candidateId));
    const consensus = this.consensus(evaluatedResults, evaluations);

    for (const result of evaluatedResults) {
      const evaluation = evaluations.find(item => item.candidateId === result.candidateId);
      if (!evaluation) throw new EvolutionEngineError("ENGINE_EVALUATION_MISMATCH");
      const verification = verifications[results.findIndex(item => item.candidateId === result.candidateId)];
      if (!verification) throw new EvolutionEngineError("ENGINE_VERIFICATION_MISMATCH");
      this.memory.record(task.taskKey, result, evaluation, verification.passed);
    }

    const improvementProposals: ImprovementProposal[] = [];
    if (this.generateImprovements && decision.path !== "fast") {
      for (const proposal of await this.generateImprovements({ task, consensus, results: evaluatedResults })) {
        if (!proposal.requiresApproval) throw new EvolutionEngineError("ENGINE_IMPROVEMENT_MUST_REQUIRE_APPROVAL");
        improvementProposals.push(proposal);
      }
    }

    return { taskId: task.id, decision, results, evaluations, consensus, improvementProposals, evaluationCost, evaluationLatencyMs };
  }
}
