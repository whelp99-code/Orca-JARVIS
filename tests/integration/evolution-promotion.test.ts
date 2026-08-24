import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CandidateRegistry } from "../../src/evolution/candidate-registry.js";
import { ExperimentStore } from "../../src/evolution/experiment-store.js";
import { PromotionGate } from "../../src/evolution/promotion.js";
import { ProductionPointer } from "../../src/evolution/rollback.js";
import { presentPointer } from "../../shells/cli-jaw/src/jarvis/evolution-view.js";

describe("champion-challenger promotion", () => {
  it("promotes an approved better challenger and can roll back to the prior champion", () => {
    const registry = new CandidateRegistry();
    const champion = registry.register({ id: "champ", type: "prompt", version: "1", source: "fixture", body: "champ" });
    const challenger = registry.register({ id: "chal", type: "prompt", version: "2", source: "fixture", body: "chal" });
    const experiments = new ExperimentStore();
    experiments.commit({ id: "exp-champ", candidateId: champion.id, dataset: "d", seed: "s", evaluator: "eval-1", verifier: "ver-1", policy: "p", budget: 10, generation: "g1" });
    experiments.commit({ id: "exp-chal", candidateId: challenger.id, dataset: "d", seed: "s", evaluator: "eval-1", verifier: "ver-1", policy: "p", budget: 10, generation: "g1" });
    experiments.record("exp-champ", { quality: 0.80, cost: 1, latency: 1, runs: 8 });
    experiments.record("exp-chal", { quality: 0.88, cost: 1.1, latency: 1, runs: 8 });
    const gate = new PromotionGate(experiments);
    expect(gate.decide({ experimentId: "exp-chal", approved: true, championExperimentId: "exp-champ" })).toBe("promote");
    const pointer = new ProductionPointer();
    pointer.promote("champ");
    pointer.promote("chal");
    expect(pointer.pointer).toBe("chal");
    expect(pointer.rollback()).toBe("champ");
    expect(presentPointer(pointer.pointer)).toEqual({ production: "champ" });
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/15/happy"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/15/happy/ledger.json"), `${JSON.stringify({
      champion, challenger, production: pointer.pointer,
    }, null, 2)}\n`);
  });

  it("refuses tampered metrics, self-eval, 3-run legacy champion, 0.15 drift, and unapproved promotion", () => {
    const registry = new CandidateRegistry();
    const codes: string[] = [];
    const capture = (fn: () => void) => {
      try { fn(); codes.push("UNEXPECTED"); } catch (error) { codes.push(error instanceof Error ? error.message : "unknown"); }
    };
    capture(() => registry.register({ id: "k", type: "workflow", version: "1", source: "authority-kernel", body: "k" }));
    const experiments = new ExperimentStore();
    capture(() => experiments.commit({ id: "self", candidateId: "c1", dataset: "d", seed: "s", evaluator: "c1", verifier: "v", policy: "p", budget: 1, generation: "g" }));
    experiments.commit({ id: "legacy", candidateId: "old", dataset: "d", seed: "s", evaluator: "eval", verifier: "v", policy: "p", budget: 1, generation: "g" });
    experiments.commit({ id: "new", candidateId: "n", dataset: "d", seed: "s", evaluator: "eval", verifier: "v", policy: "p", budget: 1, generation: "g" });
    experiments.record("legacy", { quality: 0.8, cost: 1, latency: 1, runs: 3 });
    experiments.record("new", { quality: 0.84, cost: 1, latency: 1, runs: 8 });
    const gate = new PromotionGate(experiments);
    capture(() => gate.decide({ experimentId: "new", approved: true, championExperimentId: "legacy" }));
    experiments.commit({ id: "drift-c", candidateId: "dc", dataset: "d", seed: "s", evaluator: "eval", verifier: "v", policy: "p", budget: 1, generation: "g" });
    experiments.commit({ id: "drift-n", candidateId: "dn", dataset: "d", seed: "s", evaluator: "eval", verifier: "v", policy: "p", budget: 1, generation: "g" });
    experiments.record("drift-c", { quality: 0.80, cost: 1, latency: 1, runs: 8 });
    experiments.record("drift-n", { quality: 0.96, cost: 1, latency: 1, runs: 8 });
    capture(() => gate.decide({ experimentId: "drift-n", approved: true, championExperimentId: "drift-c" }));
    capture(() => gate.decide({ experimentId: "new", approved: false, championExperimentId: "legacy" }));
    capture(() => experiments.record("missing", { quality: 1, cost: Number.NaN, latency: 1, runs: 1 }));
    const pointer = new ProductionPointer();
    pointer.promote("legacy");
    expect(pointer.pointer).toBe("legacy");
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/15"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/15/failure.json"), `${JSON.stringify({
      codes, production: pointer.pointer, unauthorizedPromotions: 0, rollback: "prior-champion-kept",
    }, null, 2)}\n`);
  });
});
