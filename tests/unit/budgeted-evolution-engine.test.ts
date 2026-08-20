import { describe, expect, it } from "vitest";
import { BudgetedEvolutionEngine, DEFAULT_ROUTING_POLICY, InMemoryPerformanceMemory, type BudgetedTask, type PerformanceRecord } from "../../src/budgeted-evolution-engine.js";
import { candidateFingerprint, type CandidateProfile } from "../../src/evolution-contracts.js";

const championCandidate: CandidateProfile = { id: "champion", kind: "agent", capabilities: ["code", "review"], costWeight: 0.1, latencyWeight: 0.1 };
const candidates: CandidateProfile[] = [
  championCandidate,
  { id: "challenger", kind: "agent", capabilities: ["code", "review"], costWeight: 0.2, latencyWeight: 0.2 },
  { id: "specialist", kind: "workflow", capabilities: ["code", "review", "research"], costWeight: 0.4, latencyWeight: 0.3 },
];

const task: BudgetedTask = {
  id: "task-1",
  taskKey: "code-review",
  objective: "review code",
  requiredCapabilities: ["code", "review"],
  budget: { maxCandidates: 3, maxEvolutionRounds: 1 },
};

const seedChampion = (memory: InMemoryPerformanceMemory, overrides: Partial<PerformanceRecord> = {}) => memory.seed({
  taskKey: "code-review",
  candidateId: "champion",
  candidateFingerprint: candidateFingerprint(championCandidate),
  runs: 5,
  successes: 5,
  avgScore: 0.91,
  avgCost: 0.1,
  avgLatencyMs: 100,
  updatedAt: new Date().toISOString(),
  ...overrides,
});

const engine = (memory: InMemoryPerformanceMemory, random = () => 0.99) => new BudgetedEvolutionEngine({
  candidates,
  memory,
  executeCandidate: async candidate => ({ candidateId: candidate.id, output: candidate.id, cost: candidate.id === "specialist" ? 0.8 : 0.1, latencyMs: candidate.id === "specialist" ? 1_000 : 100 }),
  evaluateCandidate: async result => ({ candidateId: result.candidateId, quality: result.candidateId === "challenger" ? 0.95 : 0.9, safety: 0.95, efficiency: 0.9 }),
  cheapVerifier: async () => ({ passed: true }),
  policy: DEFAULT_ROUTING_POLICY,
  generateImprovements: async ({ consensus }) => [{ id: "p1", targetCandidateId: consensus.selectedCandidateId, reason: "measured", mutation: { prompt: "v2" }, expectedGain: 0.05, requiresApproval: true }],
  random,
});

describe("BudgetedEvolutionEngine", () => {
  it("uses one trusted champion on the fast path", async () => {
    const memory = new InMemoryPerformanceMemory(); seedChampion(memory);
    const result = await engine(memory).run(task);
    expect(result.decision).toMatchObject({ path: "fast", reason: "trusted_champion", candidateIds: ["champion"] });
    expect(result.results).toHaveLength(1);
    expect(result.improvementProposals).toHaveLength(0);
  });

  it("samples only one challenger instead of evaluating every candidate", async () => {
    const memory = new InMemoryPerformanceMemory(); seedChampion(memory);
    const result = await engine(memory, () => 0).run(task);
    expect(result.decision.path).toBe("slow");
    expect(result.decision.reason).toBe("sampled_challenger");
    expect(result.results).toHaveLength(2);
    expect(result.results.map(result => result.candidateId)).toEqual(["champion", "challenger"]);
  });

  it("uses the slow path for novel work when no trusted champion applies", async () => {
    const memory = new InMemoryPerformanceMemory();
    const result = await engine(memory).run({ ...task, novelty: 0.9 });
    expect(result.decision.path).toBe("slow");
    expect(result.decision.reason).toBe("novel_task");
    expect(result.results).toHaveLength(2);
  });

  it("uses the lab path for high-risk work", async () => {
    const memory = new InMemoryPerformanceMemory(); seedChampion(memory);
    const result = await engine(memory).run({ ...task, risk: "high" });
    expect(result.decision.path).toBe("lab");
    expect(result.decision.reason).toBe("high_risk");
    expect(result.results.length).toBeLessThanOrEqual(DEFAULT_ROUTING_POLICY.maxLabCandidates);
  });

  it("requires complete capability coverage", () => {
    const partial = new BudgetedEvolutionEngine({
      candidates: [{ id: "partial", kind: "agent", capabilities: ["code"] }],
      memory: new InMemoryPerformanceMemory(),
      executeCandidate: async candidate => ({ candidateId: candidate.id, output: candidate.id }),
      evaluateCandidate: async result => ({ candidateId: result.candidateId, quality: 1, safety: 1, efficiency: 1 }),
      cheapVerifier: async () => ({ passed: true }),
    });

    expect(() => partial.decide(task)).toThrow("ENGINE_NO_CAPABLE_CANDIDATE");
  });

  it("honors the task candidate cap", () => {
    const decision = engine(new InMemoryPerformanceMemory()).decide({
      ...task,
      forceLab: true,
      budget: { ...task.budget, maxCandidates: 1 },
    });

    expect(decision.candidateIds).toHaveLength(1);
  });

  it("stops expensive evaluation when the budget would be exceeded", async () => {
    const memory = new InMemoryPerformanceMemory();
    const tightPolicy = { ...DEFAULT_ROUTING_POLICY, maxEvaluationCost: 0.5 };
    const budgeted = new BudgetedEvolutionEngine({
      candidates,
      memory,
      executeCandidate: async candidate => ({ candidateId: candidate.id, output: candidate.id, cost: candidate.id === "specialist" ? 0.8 : 0.1, latencyMs: candidate.id === "specialist" ? 1_000 : 100 }),
      evaluateCandidate: async result => ({ candidateId: result.candidateId, quality: 0.9, safety: 0.95, efficiency: 0.9 }),
      cheapVerifier: async () => ({ passed: true }),
      policy: tightPolicy,
    });
    const result = await budgeted.run({ ...task, forceLab: true });
    expect(result.results).toHaveLength(3);
    expect(result.evaluations).toHaveLength(2);
    expect(result.evaluationCost).toBeLessThanOrEqual(tightPolicy.maxEvaluationCost);
  });

  it("keeps promotion/improvement proposals approval-gated", async () => {
    const memory = new InMemoryPerformanceMemory();
    const result = await engine(memory).run({ ...task, novelty: 1 });
    expect(result.improvementProposals).toHaveLength(1);
    expect(result.improvementProposals[0]?.requiresApproval).toBe(true);
  });
});
