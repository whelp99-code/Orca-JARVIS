import { randomUUID } from "node:crypto";
import { AuthorityDb } from "./db.js";
import { EvolutionEngineError, scoreEvaluation } from "./evolution-contracts.js";
import type { CandidateResult, Evaluation } from "./evolution-contracts.js";
import type { PerformanceMemory, PerformanceRecord, RoutingPolicy } from "./budgeted-evolution-engine.js";

export class SqlitePerformanceMemory implements PerformanceMemory {
  constructor(private readonly authority: AuthorityDb) {}

  list(taskKey: string): PerformanceRecord[] {
    return (this.authority.db.prepare(`
      SELECT
        task_key,
        candidate_id,
        candidate_fingerprint,
        COUNT(*) AS runs,
        SUM(CASE WHEN outcome='verified' THEN 1 ELSE 0 END) AS successes,
        AVG(COALESCE(score,0)) AS avg_score,
        AVG(cost) AS avg_cost,
        AVG(latency_ms) AS avg_latency_ms,
        MAX(created_at) AS updated_at
      FROM evolution_shadow_observations
      WHERE task_key=?
      GROUP BY task_key,candidate_id,candidate_fingerprint
      ORDER BY candidate_id,candidate_fingerprint
    `).all(taskKey) as Array<Record<string, unknown>>)
      .map(row => ({
        taskKey: String(row.task_key),
        candidateId: String(row.candidate_id),
        candidateFingerprint: String(row.candidate_fingerprint),
        runs: Number(row.runs),
        successes: Number(row.successes),
        avgScore: Number(row.avg_score),
        avgCost: Number(row.avg_cost),
        avgLatencyMs: Number(row.avg_latency_ms),
        updatedAt: String(row.updated_at),
      }));
  }

  champion(taskKey: string, policy: RoutingPolicy): PerformanceRecord | undefined {
    return this.list(taskKey)
      .filter(record => record.runs >= policy.championMinRuns && record.avgScore >= policy.championMinScore)
      .sort((a, b) => b.avgScore - a.avgScore || a.avgCost - b.avgCost || a.avgLatencyMs - b.avgLatencyMs)[0];
  }

  record(taskKey: string, result: CandidateResult, evaluation: Evaluation, success: boolean, now = new Date()): PerformanceRecord {
    this.append(taskKey, result, success ? "verified" : "verification_failed", success ? scoreEvaluation(evaluation) : null, now);
    const fingerprint = result.candidateFingerprint;
    if (!fingerprint) throw new EvolutionEngineError("ENGINE_RESULT_IDENTITY_MISMATCH");
    const next = this.list(taskKey).find(record => record.candidateId === result.candidateId && record.candidateFingerprint === fingerprint);
    if (!next) throw new EvolutionEngineError("ENGINE_EVALUATION_MISMATCH");
    return next;
  }

  recordFailure(taskKey: string, result: CandidateResult, now = new Date()): PerformanceRecord {
    this.append(taskKey, result, "verification_failed", null, now);
    const fingerprint = result.candidateFingerprint;
    if (!fingerprint) throw new EvolutionEngineError("ENGINE_RESULT_IDENTITY_MISMATCH");
    const next = this.list(taskKey).find(record => record.candidateId === result.candidateId && record.candidateFingerprint === fingerprint);
    if (!next) throw new EvolutionEngineError("ENGINE_EVALUATION_MISMATCH");
    return next;
  }

  seed(record: PerformanceRecord): void {
    for (let index = 0; index < record.runs; index += 1) {
      this.append(
        record.taskKey,
        {
          candidateId: record.candidateId,
          candidateFingerprint: record.candidateFingerprint,
          output: null,
          cost: record.avgCost,
          latencyMs: record.avgLatencyMs,
        },
        index < record.successes ? "verified" : "verification_failed",
        index < record.successes ? record.avgScore : null,
        new Date(record.updatedAt),
      );
    }
  }

  private append(taskKey: string, result: CandidateResult, outcome: "verified" | "verification_failed", score: number | null, now: Date): void {
    const fingerprint = result.candidateFingerprint;
    if (!fingerprint) throw new EvolutionEngineError("ENGINE_RESULT_IDENTITY_MISMATCH");
    this.authority.db.prepare(`
      INSERT INTO evolution_shadow_observations(
        observation_id,task_key,candidate_id,candidate_fingerprint,outcome,score,cost,latency_ms,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `).run(
      randomUUID(),
      taskKey,
      result.candidateId,
      fingerprint,
      outcome,
      score,
      result.cost ?? 0,
      result.latencyMs ?? 0,
      now.toISOString(),
    );
  }
}
