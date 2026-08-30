import type { AuthorityDb } from "./db.js";
import { DailyControlScheduler, type DailyPhaseHandler } from "./daily-control-scheduler.js";
import { generateMorningBrief, type MorningBrief } from "./morning-brief.js";
import { createEveningCloseout, type EveningCloseout } from "./evening-closeout.js";
import { NotificationIntentStore } from "./notification-intents.js";
import { PersonalOperatingReadModel } from "./personal-operating-read.js";
import { MemoryCandidateClassifier } from "./memory-candidates.js";
import { buildSecondBrainReadiness, type SecondBrainReadinessProbe } from "./second-brain-readiness.js";
import { createSecondBrainProviderReadinessProbe } from "./second-brain-provider-readiness.js";

export type DailyControlRuntimeOptions = Readonly<{
  db: AuthorityDb;
  owner?: string;
  readiness?: SecondBrainReadinessProbe;
  clock?: () => Date;
  intervalMs?: number;
}>;
export type DailyControlStatus = Readonly<{
  schema_version: 1;
  mode: "once" | "run";
  checked_at: string;
  loop_date: string;
  due: readonly string[];
  completed: readonly string[];
  degraded: boolean;
  readiness: unknown;
  notifications: number;
  memory_candidates: number;
  runs: readonly Record<string, unknown>[];
}>;

function validDate(clock: () => Date): Date {
  const now = clock();
  if (!Number.isFinite(now.getTime())) throw new Error("DAILY_RUNTIME_CLOCK_INVALID");
  return now;
}

export class DailyControlRuntime {
  private readonly scheduler: DailyControlScheduler;
  private readonly read: PersonalOperatingReadModel;
  private readonly notifications: NotificationIntentStore;
  private readonly db: AuthorityDb["db"];
  private readonly candidates: MemoryCandidateClassifier;
  private readonly clock: () => Date;
  private readonly owner: string;
  private readonly readiness: SecondBrainReadinessProbe;

  constructor(options: DailyControlRuntimeOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.owner = options.owner ?? `daily-control:${process.pid}`;
    this.db = options.db.db;
    this.scheduler = new DailyControlScheduler(options.db.db, this.clock);
    this.read = new PersonalOperatingReadModel(options.db.db);
    this.notifications = new NotificationIntentStore(options.db.db);
    this.candidates = new MemoryCandidateClassifier(options.db.db);
    this.readiness = options.readiness ?? createSecondBrainProviderReadinessProbe();
  }

  async once(now = validDate(this.clock)): Promise<DailyControlStatus> {
    const plan = this.scheduler.plan(now);
    const completed: string[] = [];
    let notifications = 0;
    const memoryCandidates = this.generateMemoryCandidates(now);
    const readiness = await buildSecondBrainReadiness(this.readiness, now);
    const readinessState = typeof readiness === "object" && readiness !== null
      ? readiness : { state: "unknown" };
    for (const decision of plan.due) {
      const phase = decision.phase;
      if (phase === "in_day") continue;
      const handler: DailyPhaseHandler = phase === "morning"
        ? async (run) => {
          const brief = this.morning(run.loop_date, now, readinessState);
          notifications += this.notifyFailures(run.loop_date, now);
          return brief;
        }
        : async (run) => this.evening(run.loop_date, run.run_id, now);
      try {
        await this.scheduler.execute(phase, this.owner, handler, now);
        completed.push(phase);
      } catch (error) {
        if (!(error instanceof Error) || !/DAILY_LOOP_NOT_PENDING/u.test(error.message)) throw error;
      }
    }
    const runs = this.read.today(plan.loop_date, now.toISOString()).runs;
    const degraded = "readiness" in readinessState && readinessState.readiness !== "ready";
    return {
      schema_version: 1, mode: "once", checked_at: now.toISOString(),
      loop_date: plan.loop_date, due: plan.due.map((item) => item.phase), completed,
      degraded, readiness: readinessState, notifications, memory_candidates: memoryCandidates, runs,
    };
  }

  async reconcile(now = validDate(this.clock)): Promise<DailyControlStatus> {
    return this.once(now);
  }

  status(now = validDate(this.clock)): DailyControlStatus {
    const plan = this.scheduler.plan(now);
    const projection = this.read.today(plan.loop_date, now.toISOString());
    return {
      schema_version: 1, mode: "once", checked_at: now.toISOString(),
      loop_date: plan.loop_date, due: plan.due.map((item) => item.phase),
      completed: projection.runs.filter((run) => run.state === "completed")
        .map((run) => String(run.idempotency_key)), degraded: true,
      readiness: { state: "not_checked" },
      notifications: projection.notifications.length,
      memory_candidates: this.read.memoryCandidates(now.toISOString()).length, runs: projection.runs,
    };
  }

  private morning(loopDate: string, now: Date, readiness: unknown): MorningBrief {
    let state = "unknown";
    if (typeof readiness === "object" && readiness !== null && "stages" in readiness) {
      const stages = readiness.stages;
      if (typeof stages === "object" && stages !== null && "freshness" in stages) {
        const freshness = stages.freshness;
        if (typeof freshness === "object" && freshness !== null && "state" in freshness) {
          state = String(freshness.state);
        }
      }
    }
    const readinessClass = typeof readiness === "object" && readiness !== null
      && "readiness" in readiness ? String(readiness.readiness) : "unavailable";
    const sourceState = state === "fresh" || state === "no_data" || state === "stale"
      ? state
      : readinessClass === "degraded" ? "stale" : "failed";
    const projection = this.read.today(loopDate, now.toISOString());
    const failures = this.read.failures(20);
    return generateMorningBrief({
      loop_date: loopDate, now: now.toISOString(),
      refresh: { state: sourceState, completed_at: null, source_id: "src:pos:v1:second-brain:primary" },
      sources: [{ source_id: "second-brain", state: sourceState === "failed" ? "unavailable" : sourceState,
        detail: "refresh is observed, never invoked by daily control", checked_at: now.toISOString() }],
      actions: [], blocked: failures.map((item) => String(item.summary)),
      decisions: projection.decisions.map((item) => String(item.request_id)), workers: [],
      risks: failures.filter((item) => ["P0", "P1"].includes(String(item.severity)))
        .map((item) => String(item.summary)),
    });
  }

  private evening(loopDate: string, runId: string, now: Date): EveningCloseout {
    const failures = this.read.failures(200);
    const candidates = this.read.memoryCandidates(now.toISOString(), 200);
    return createEveningCloseout({
      loop_date: loopDate, run_id: runId, completions: [],
      open_items: failures.map((item) => ({ item_id: String(item.failure_id), state: "failed", reason: String(item.summary) })),
      decisions: [], candidate_ids: candidates.map((item) => String(item.candidate_id)), improvements: [],
      tomorrow_first_action: failures.length > 0 ? "Resolve the oldest unresolved terminal failure" : null,
      now: now.toISOString(),
    });
  }

  private notifyFailures(loopDate: string, now: Date): number {
    const failures = this.read.failures(20).filter((item) => ["P0", "P1"].includes(String(item.severity)));
    let count = 0;
    for (const failure of failures) {
      const id = String(failure.failure_id);
      const base = {
        intent_id: `intent:daily:${loopDate}:${id}`, correlation_id: `corr:daily:${loopDate}:${id}`,
        idempotency_key: `notify:daily:${loopDate}:${id}`, urgency: "action" as const,
        channel: "browser" as const, title: "Unresolved terminal failure", summary: String(failure.summary),
        resource_id: `resource:failure:${id}`, expires_at: new Date(now.getTime() + 24 * 3600_000).toISOString(),
        now: now.toISOString(),
      };
      this.notifications.enqueue({ ...base, dedup_key: NotificationIntentStore.dedupKey(base) });
      count += 1;
    }
    return count;
  }

  private generateMemoryCandidates(now: Date): number {
    const rows = this.db.prepare(
      "SELECT r.resolution_id,r.failure_id,r.summary FROM terminal_resolutions r "
      + "ORDER BY r.verified_at,r.resolution_id LIMIT 64",
    ).all() as Array<{ resolution_id: string; failure_id: string; summary: string }>;
    let created = 0;
    for (const row of rows) {
      const result = this.candidates.classify({
        candidate_id: `memcand:daily:${row.resolution_id}`,
        correlation_id: `corr:memory:${row.resolution_id}`,
        idempotency_key: `memory:resolution:${row.resolution_id}`,
        origin: "verified_outcome", operation: "remember", content: row.summary,
        source_refs: [row.resolution_id, row.failure_id], sensitivity: "normal", confidence: "verified",
        purpose: "personal_memory", expires_at: new Date(now.getTime() + 365 * 24 * 3600_000).toISOString(),
        now: now.toISOString(), second_brain_state: "offline",
      });
      if (result.state === "classified") created += 1;
    }
    return created;
  }
}

export async function runDailyControlOnce(options: DailyControlRuntimeOptions, now?: Date): Promise<DailyControlStatus> {
  return new DailyControlRuntime(options).once(now);
}
export async function startDailyControlRuntime(options: DailyControlRuntimeOptions): Promise<() => void> {
  const runtime = new DailyControlRuntime(options);
  let stopped = false;
  const tick = async (): Promise<void> => { if (!stopped) await runtime.once(); };
  await tick();
  const timer = setInterval(() => { void tick(); }, options.intervalMs ?? 60_000);
  return () => { stopped = true; clearInterval(timer); };
}
