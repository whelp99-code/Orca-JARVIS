import { describe, expect, it } from "vitest";
import { BudgetedEvolutionEngine, InMemoryPerformanceMemory, type BudgetedTask } from "../../src/budgeted-evolution-engine.js";
import { EvolutionShadowRuntime } from "../../src/evolution-shadow-runtime.js";
import { candidateFingerprint, type CandidateProfile } from "../../src/evolution-contracts.js";

const task: BudgetedTask = {
  id: "shadow-1",
  taskKey: "code-review",
  objective: "review code",
  requiredCapabilities: ["code"],
  risk: "low",
  novelty: 0,
  budget: { maxCandidates: 2, maxEvolutionRounds: 0 },
};

describe("EvolutionShadowRuntime", () => {
  it("returns production output unchanged while recording shadow choice", async () => {
    const memory = new InMemoryPerformanceMemory();
    const champion: CandidateProfile = { id: "champion", kind: "agent", capabilities: ["code"] };
    memory.seed({ taskKey: "code-review", candidateId: "champion", candidateFingerprint: candidateFingerprint(champion), runs: 5, successes: 5, avgScore: 0.9, avgCost: 0.1, avgLatencyMs: 100, updatedAt: new Date().toISOString() });
    const engine = new BudgetedEvolutionEngine({
      candidates: [
        champion,
        { id: "challenger", kind: "agent", capabilities: ["code"] },
      ],
      memory,
      executeCandidate: async candidate => ({ candidateId: candidate.id, output: `shadow:${candidate.id}`, cost: 0.1, latencyMs: 10 }),
      evaluateCandidate: async result => ({ candidateId: result.candidateId, quality: 0.9, safety: 0.9, efficiency: 0.9 }),
      cheapVerifier: async () => ({ passed: true }),
      random: () => 1,
    });
    const observations: unknown[] = [];
    const runtime = new EvolutionShadowRuntime(engine, async () => ({ candidateId: "production", output: "production-result" }), { record: observation => { observations.push(observation); } });
    const result = await runtime.run(task);
    expect(result.production.output).toBe("production-result");
    expect(result.shadow?.consensus.selectedCandidateId).toBe("champion");
    expect(observations).toHaveLength(1);
  });

  it("returns production output when the shadow engine fails", async () => {
    const engine = new BudgetedEvolutionEngine({
      candidates: [{ id: "candidate", kind: "agent", capabilities: ["code"] }],
      memory: new InMemoryPerformanceMemory(),
      executeCandidate: async () => { throw new Error("SHADOW_ENGINE_BOOM"); },
      evaluateCandidate: async result => ({ candidateId: result.candidateId, quality: 1, safety: 1, efficiency: 1 }),
      cheapVerifier: async () => ({ passed: true }),
    });
    const runtime = new EvolutionShadowRuntime(
      engine,
      async () => ({ candidateId: "production", output: "production-result" }),
      { record: () => undefined },
    );

    await expect(runtime.run(task)).resolves.toMatchObject({
      production: { output: "production-result" },
      shadowFailure: { stage: "engine", message: "SHADOW_ENGINE_BOOM" },
    });
  });

  it("returns production output when the observation sink fails", async () => {
    const engine = new BudgetedEvolutionEngine({
      candidates: [{ id: "candidate", kind: "agent", capabilities: ["code"] }],
      memory: new InMemoryPerformanceMemory(),
      executeCandidate: async candidate => ({ candidateId: candidate.id, output: candidate.id, cost: 0.1, latencyMs: 1 }),
      evaluateCandidate: async result => ({ candidateId: result.candidateId, quality: 1, safety: 1, efficiency: 1 }),
      cheapVerifier: async () => ({ passed: true }),
    });
    const runtime = new EvolutionShadowRuntime(
      engine,
      async () => ({ candidateId: "production", output: "production-result" }),
      { record: () => { throw new Error("SHADOW_SINK_BOOM"); } },
    );

    await expect(runtime.run(task)).resolves.toMatchObject({
      production: { output: "production-result" },
      shadow: { consensus: { selectedCandidateId: "candidate" } },
      shadowFailure: { stage: "sink", message: "SHADOW_SINK_BOOM" },
    });
  });
});
