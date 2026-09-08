import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { DailyLoopStore } from "./daily-loop-store.js";
import { assertDailyLoopIntegrity } from "./daily-loop-integrity.js";
import { parseDailyLoopBudgets, parseDailyLoopClaim, parseDailyLoopInstant, parseDailyLoopRunId } from "./daily-loop-input.js";
import { DailyBudgetExceeded, dailyLoopUsage, dailyUsageExhausted } from "./daily-loop-usage.js";
import { kstLocalDate } from "./daily-loop-time.js";
import { verifyLiveNativeEveningEnvelope, verifyNativeEveningEnvelope, type NativeEveningEnvelope } from "./evening-native-envelope.js";
import { invalidCloseout } from "./evening-closeout-parse-values.js";
import type { TrustedCloseoutKey } from "./evening-closeout-types.js";
import { readEveningNativeSource } from "./evening-native-source.js";
import { bindNativeEvening, nativeEveningDependencies, verifyNativeEveningLineage } from "./evening-native-lineage.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";

type SourceConfig = { readonly repository_identities: readonly string[]; readonly max_records: number; readonly max_bytes: number };
type Row = Record<string, unknown>;
const reportRefs = (runId: string, stepId: string, artifactId: string) => [
  { kind: "daily_run" as const, id: runId, component_id: runId },
  { kind: "daily_step" as const, id: stepId, component_id: stepId },
  { kind: "evening_closeout" as const, id: artifactId, component_id: artifactId },
];

/** Internal configured publication boundary; callers do not choose repository authorization. */
export class NativeEveningStore {
  constructor(private readonly db: AuthorityDb, private readonly key: TrustedCloseoutKey,
    private readonly config: SourceConfig, private readonly clock: () => Date = () => new Date(),
    private readonly afterPersisted?: () => void) {}

  private verify(value: unknown, at: Date): NativeEveningEnvelope {
    const artifact = verifyNativeEveningEnvelope(value, this.key);
    if (canonicalize(artifact.repository_identities) !== canonicalize(this.config.repository_identities)
      || artifact.max_source_records !== this.config.max_records || artifact.max_source_bytes !== this.config.max_bytes) return invalidCloseout();
    return verifyLiveNativeEveningEnvelope(this.db, artifact, this.key, at);
  }

  private dependencies(artifact: NativeEveningEnvelope) {
    return nativeEveningDependencies(this.db, readEveningNativeSource(this.db, {
      ...this.config, local_date: artifact.local_date, observed_at: new Date(artifact.generated_at) }));
  }

  private assertPublished(artifact: NativeEveningEnvelope, stepId: string, at: Date): void {
    const row = this.db.db.prepare("SELECT * FROM native_evening_publications WHERE run_id=?").get(artifact.run_id) as Row | undefined;
    if (!row || row.step_id !== stepId || row.artifact_id !== artifact.artifact_id || row.canonical_digest !== artifact.canonical_digest
      || String(row.published_at) < artifact.generated_at || String(row.published_at) > at.toISOString()) return invalidCloseout();
  }

  settleWithinBudget(input: { readonly claim: unknown; readonly artifact: unknown }, budgetsValue: unknown): boolean {
    const claim = parseDailyLoopClaim(input.claim); const budgets = parseDailyLoopBudgets(budgetsValue);
    return this.db.db.transaction(() => {
      const at = parseDailyLoopInstant(this.clock());
      const artifact = this.verify(input.artifact, at);
      const runId = claim.run_id; assertDailyLoopIntegrity(this.db, runId);
      const row = this.db.db.prepare("SELECT * FROM daily_loop_runs WHERE run_id=?").get(runId) as Row | undefined;
      if (!row || row.phase !== "evening" || row.loop_date !== artifact.local_date || row.correlation_id !== artifact.correlation_id
        || artifact.run_id !== runId || row.record_version !== 1 || String(row.updated_at) > at.toISOString()) return invalidCloseout();
      const loop = new DailyLoopStore(this.db); const steps = loop.steps(runId); const step = steps[0];
      if (steps.length !== 1 || !step || step.step_key !== "evening_summary" || step.sequence !== 1) return invalidCloseout();
      const projections = new MemoryProjectionAuthority(this.db);
      if ([runId, step.step_id, artifact.artifact_id].some(id => projections.isProjectionIdSuppressed(id))) return invalidCloseout();
      const dependencies = this.dependencies(artifact);
      if (step.state === "completed") {
        const stored = this.db.db.prepare("SELECT detail_json FROM daily_loop_steps WHERE step_id=?").get(step.step_id) as Row;
        if (stored.detail_json !== canonicalize(artifact) || row.state !== "completed") return invalidCloseout();
        this.assertPublished(artifact, step.step_id, at);
        verifyNativeEveningLineage(this.db, reportRefs(runId, step.step_id, artifact.artifact_id), dependencies);
        const exceeded = dailyUsageExhausted(dailyLoopUsage(this.db, artifact.local_date, this.key), budgets);
        if (exceeded) throw new DailyBudgetExceeded(exceeded);
        return false;
      }
      if (!["claimed", "running"].includes(String(row.state)) || step.state !== "pending"
        || kstLocalDate(at) !== artifact.local_date || at.toISOString() < String(row.updated_at)
        || at.toISOString() < String(row.not_before) || row.lease_expires_at !== claim.lease_expires_at
        || row.expires_at !== claim.deadline_at) return invalidCloseout();
      loop.start(claim, at);
      loop.completeStep({ claim, step, detail: artifact, at });
      bindNativeEvening(this.db, reportRefs(runId, step.step_id, artifact.artifact_id), dependencies, at);
      this.afterPersisted?.();
      const finished = parseDailyLoopInstant(this.clock());
      if (finished < at || kstLocalDate(finished) !== artifact.local_date) return invalidCloseout();
      this.verify(artifact, finished);
      if (canonicalize(this.dependencies(artifact)) !== canonicalize(dependencies)) return invalidCloseout();
      loop.complete(claim, finished);
      this.db.db.prepare(`INSERT INTO native_evening_publications(run_id,step_id,artifact_id,canonical_digest,published_at)
        VALUES(?,?,?,?,?)`).run(runId, step.step_id, artifact.artifact_id, artifact.canonical_digest, finished.toISOString());
      const exceeded = dailyUsageExhausted(dailyLoopUsage(this.db, artifact.local_date, this.key), budgets);
      if (exceeded) throw new DailyBudgetExceeded(exceeded);
      return true;
    }).immediate();
  }

  read(runIdValue: unknown): NativeEveningEnvelope {
    const runId = parseDailyLoopRunId(runIdValue);
    return this.db.db.transaction(() => {
      const at = parseDailyLoopInstant(this.clock()); assertDailyLoopIntegrity(this.db, runId);
      const row = this.db.db.prepare(`SELECT s.step_id,s.detail_json,r.loop_date,r.correlation_id,r.phase,r.updated_at
        FROM daily_loop_runs r JOIN daily_loop_steps s ON s.run_id=r.run_id
        WHERE r.run_id=? AND r.state='completed' AND s.state='completed' AND s.step_key='evening_summary'`).get(runId) as Row | undefined;
      if (!row || row.phase !== "evening" || String(row.updated_at) > at.toISOString()) return invalidCloseout();
      const artifact = this.verify(JSON.parse(String(row.detail_json)), at);
      this.assertPublished(artifact, String(row.step_id), at);
      verifyNativeEveningLineage(this.db, reportRefs(runId, String(row.step_id), artifact.artifact_id), this.dependencies(artifact));
      if (artifact.run_id !== runId || artifact.local_date !== row.loop_date || artifact.correlation_id !== row.correlation_id) return invalidCloseout();
      const projections = new MemoryProjectionAuthority(this.db);
      if ([runId, String(row.step_id), artifact.artifact_id].some(id => projections.isProjectionIdSuppressed(id))) return invalidCloseout();
      return artifact;
    }).deferred();
  }
}
