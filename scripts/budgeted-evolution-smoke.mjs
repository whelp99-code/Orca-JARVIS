import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityDb } from "../dist/src/db.js";
import { BudgetedEvolutionEngine, DEFAULT_ROUTING_POLICY, InMemoryPerformanceMemory } from "../dist/src/budgeted-evolution-engine.js";
import { candidateFingerprint } from "../dist/src/evolution-contracts.js";
import { EvolutionShadowRuntime } from "../dist/src/evolution-shadow-runtime.js";
import { SqlitePerformanceMemory } from "../dist/src/sqlite-performance-memory.js";

const scenarioFlag = process.argv.indexOf("--scenario");
const scenario = scenarioFlag >= 0 ? process.argv[scenarioFlag + 1] : undefined;

const sqliteScenario = async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-evolution-smoke-"));
  const path = join(root, "authority.sqlite");
  let db;
  let result;
  try {
    db = new AuthorityDb(path);
    await db.migrate();
    const memory = new SqlitePerformanceMemory(db);
    const candidate = { id: "codex", kind: "agent", capabilities: ["code", "review"] };
    const fingerprint = candidateFingerprint(candidate);
    const evaluation = { candidateId: candidate.id, quality: 0.9, safety: 0.95, efficiency: 0.8 };
    for (let index = 0; index < 3; index += 1) {
      memory.record("code-review", { candidateId: candidate.id, candidateFingerprint: fingerprint, output: null, cost: 0.1, latencyMs: 100 }, evaluation, true);
    }
    memory.recordFailure("code-review", { candidateId: candidate.id, candidateFingerprint: `${fingerprint}:old`, output: null, cost: 0.2, latencyMs: 200 });
    db.close();
    db = new AuthorityDb(path);
    await db.migrate();
    const reloaded = new SqlitePerformanceMemory(db);
    const rows = db.db.prepare("SELECT COUNT(*) AS count FROM evolution_shadow_observations").get().count;
    const migrations = db.db.prepare("SELECT id FROM schema_migrations ORDER BY id").all().map(row => row.id);
    const champion = reloaded.champion("code-review", DEFAULT_ROUTING_POLICY);
    const ok = rows === 4
      && migrations.includes("028_negative_evidence.sql")
      && migrations.includes("029_budgeted_evolution_shadow.sql")
      && champion?.candidateId === "codex"
      && champion.candidateFingerprint === fingerprint;
    result = { ok, scenario: "sqlite", migration: "029_budgeted_evolution_shadow.sql", rows, champion: champion?.candidateId };
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
  return { ...result, cleanup: !existsSync(root) };
};

const shadowScenario = async () => {
  const productionExecutor = async () => ({ candidateId: "production", output: "production-result" });
  const failingEngine = new BudgetedEvolutionEngine({
    candidates: [{ id: "candidate", kind: "agent", capabilities: ["code"] }],
    memory: new InMemoryPerformanceMemory(),
    executeCandidate: async () => { throw new Error("SHADOW_ENGINE_BOOM"); },
    evaluateCandidate: async result => ({ candidateId: result.candidateId, quality: 1, safety: 1, efficiency: 1 }),
    cheapVerifier: async () => ({ passed: true }),
  });
  const successfulEngine = new BudgetedEvolutionEngine({
    candidates: [{ id: "candidate", kind: "agent", capabilities: ["code"] }],
    memory: new InMemoryPerformanceMemory(),
    executeCandidate: async candidate => ({ candidateId: candidate.id, output: candidate.id, cost: 0.1, latencyMs: 1 }),
    evaluateCandidate: async result => ({ candidateId: result.candidateId, quality: 1, safety: 1, efficiency: 1 }),
    cheapVerifier: async () => ({ passed: true }),
  });
  const task = {
    id: "shadow-smoke",
    taskKey: "code-review",
    objective: "review",
    requiredCapabilities: ["code"],
    budget: { maxCandidates: 1, maxEvolutionRounds: 0 },
  };
  const engineFailure = await new EvolutionShadowRuntime(failingEngine, productionExecutor).run(task);
  const sinkFailure = await new EvolutionShadowRuntime(
    successfulEngine,
    productionExecutor,
    { record: () => { throw new Error("SHADOW_SINK_BOOM"); } },
  ).run(task);
  const stages = [engineFailure.shadowFailure?.stage, sinkFailure.shadowFailure?.stage];
  return {
    ok: engineFailure.production.output === "production-result"
      && sinkFailure.production.output === "production-result"
      && stages[0] === "engine"
      && stages[1] === "sink",
    scenario: "shadow",
    production: engineFailure.production.output,
    shadowFailure: stages,
    cleanup: true,
  };
};

const runners = { shadow: shadowScenario, sqlite: sqliteScenario };
const runner = scenario ? runners[scenario] : undefined;
if (!runner) {
  console.error(JSON.stringify({ ok: false, error: "usage: --scenario sqlite|shadow" }));
  process.exit(2);
}
const output = await runner();
console.log(JSON.stringify(output));
if (!output.ok || !output.cleanup) process.exit(1);
