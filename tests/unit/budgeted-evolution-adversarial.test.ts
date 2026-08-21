import { describe, expect, it } from "vitest";
import { BudgetedEvolutionEngine, DEFAULT_ROUTING_POLICY, InMemoryPerformanceMemory, type BudgetedTask } from "../../src/budgeted-evolution-engine.js";
import { candidateFingerprint, type CandidateProfile } from "../../src/evolution-contracts.js";

const baseTask: BudgetedTask = {
  id: "adv-1",
  taskKey: "code-review",
  objective: "review code",
  requiredCapabilities: ["code"],
  novelty: 0,
  risk: "low",
  budget: { maxCandidates: 3, maxEvolutionRounds: 0 },
};

const championCandidate: CandidateProfile = { id: "champion", kind: "agent", capabilities: ["code"] };
const candidates: CandidateProfile[] = [
  championCandidate,
  { id: "challenger", kind: "agent" as const, capabilities: ["code"] },
  { id: "third", kind: "agent" as const, capabilities: ["code"] },
];

const championMemory = () => {
  const memory = new InMemoryPerformanceMemory();
  memory.seed({ taskKey: "code-review", candidateId: "champion", candidateFingerprint: candidateFingerprint(championCandidate), runs: 5, successes: 5, avgScore: 0.9, avgCost: 0.1, avgLatencyMs: 100, updatedAt: new Date().toISOString() });
  return memory;
};

describe("BudgetedEvolutionEngine adversarial", () => {
  it("does not let an unrelated historical record create false drift", () => {
    const memory = championMemory();
    memory.seed({ taskKey: "code-review", candidateId: "removed-candidate", candidateFingerprint: "sha256:removed", runs: 5, successes: 5, avgScore: 1, avgCost: 0, avgLatencyMs: 0, updatedAt: new Date().toISOString() });
    const engine = new BudgetedEvolutionEngine({
      candidates,
      memory,
      executeCandidate: async candidate => ({ candidateId: candidate.id, output: candidate.id }),
      evaluateCandidate: async result => ({ candidateId: result.candidateId, quality: 1, safety: 1, efficiency: 1 }),
      cheapVerifier: async () => ({ passed: true }),
      policy: DEFAULT_ROUTING_POLICY,
      random: () => 1,
    });
    expect(engine.decide(baseTask)).toMatchObject({ path: "fast", reason: "trusted_champion", championId: "champion" });
  });

  it("never selects a verifier-failed candidate when at least one passes", async () => {
    const engine = new BudgetedEvolutionEngine({
      candidates,
      memory: championMemory(),
      executeCandidate: async candidate => ({ candidateId: candidate.id, output: candidate.id, cost: 0.1 }),
      evaluateCandidate: async result => ({ candidateId: result.candidateId, quality: result.candidateId === "champion" ? 1 : 0.8, safety: 1, efficiency: 1 }),
      cheapVerifier: async result => ({ passed: result.candidateId !== "champion" }),
      policy: { ...DEFAULT_ROUTING_POLICY, challengerSampleRate: 1 },
      random: () => 0,
    });
    const result = await engine.run(baseTask);
    expect(result.consensus.selectedCandidateId).toBe("challenger");
  });

  it("fails closed when all cheap verifications fail", async () => {
    const engine = new BudgetedEvolutionEngine({
      candidates,
      memory: championMemory(),
      executeCandidate: async candidate => ({ candidateId: candidate.id, output: candidate.id, cost: 0.1 }),
      evaluateCandidate: async result => ({ candidateId: result.candidateId, quality: 1, safety: 1, efficiency: 1 }),
      cheapVerifier: async () => ({ passed: false }),
      policy: DEFAULT_ROUTING_POLICY,
      random: () => 1,
    });
    await expect(engine.run(baseTask)).rejects.toThrow("ENGINE_ALL_CANDIDATES_FAILED_VERIFICATION");
  });

  it("rejects an individual candidate that already exceeds the evaluation budget", async () => {
    const engine = new BudgetedEvolutionEngine({
      candidates,
      memory: championMemory(),
      executeCandidate: async candidate => ({ candidateId: candidate.id, output: candidate.id, cost: 2, latencyMs: 1 }),
      evaluateCandidate: async result => ({ candidateId: result.candidateId, quality: 1, safety: 1, efficiency: 1 }),
      cheapVerifier: async () => ({ passed: true }),
      policy: DEFAULT_ROUTING_POLICY,
      random: () => 1,
    });
    await expect(engine.run(baseTask)).rejects.toThrow("ENGINE_EVALUATION_BUDGET_EXHAUSTED");
  });

  it("rejects a result whose candidate identity was spoofed", async () => {
    const engine = new BudgetedEvolutionEngine({
      candidates: candidates.slice(0, 1),
      memory: new InMemoryPerformanceMemory(),
      executeCandidate: async () => ({ candidateId: "spoofed", output: "spoofed", cost: 0.1, latencyMs: 1 }),
      evaluateCandidate: async result => ({ candidateId: result.candidateId, quality: 1, safety: 1, efficiency: 1 }),
      cheapVerifier: async () => ({ passed: true }),
    });

    await expect(engine.run({ ...baseTask, budget: { ...baseTask.budget, maxCandidates: 1 } }))
      .rejects.toMatchObject({ code: "ENGINE_RESULT_IDENTITY_MISMATCH" });
  });

  it("rejects non-finite execution metrics", async () => {
    const engine = new BudgetedEvolutionEngine({
      candidates: candidates.slice(0, 1),
      memory: new InMemoryPerformanceMemory(),
      executeCandidate: async candidate => ({ candidateId: candidate.id, output: candidate.id, cost: Number.NaN, latencyMs: 1 }),
      evaluateCandidate: async result => ({ candidateId: result.candidateId, quality: 1, safety: 1, efficiency: 1 }),
      cheapVerifier: async () => ({ passed: true }),
    });

    await expect(engine.run({ ...baseTask, budget: { ...baseTask.budget, maxCandidates: 1 } }))
      .rejects.toMatchObject({ code: "ENGINE_INVALID_METRIC" });
  });

  it("records verifier failures in performance memory", async () => {
    const memory = new InMemoryPerformanceMemory();
    const engine = new BudgetedEvolutionEngine({
      candidates: candidates.slice(0, 2),
      memory,
      executeCandidate: async candidate => ({ candidateId: candidate.id, output: candidate.id, cost: 0.1, latencyMs: 1 }),
      evaluateCandidate: async result => ({ candidateId: result.candidateId, quality: 1, safety: 1, efficiency: 1 }),
      cheapVerifier: async result => ({ passed: result.candidateId === "challenger" }),
    });

    await engine.run({ ...baseTask, forceLab: true, budget: { ...baseTask.budget, maxCandidates: 2 } });

    expect(memory.list(baseTask.taskKey)).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: "champion", runs: 1, successes: 0 }),
      expect.objectContaining({ candidateId: "challenger", runs: 1, successes: 1 }),
    ]));
  });
});
