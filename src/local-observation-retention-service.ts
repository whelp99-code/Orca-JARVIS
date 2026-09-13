import type { AuthorityDatabaseRuntime } from "./authority-database-runtime.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import { readRetentionConfig } from "./cli-local-timeline.js";
import { parseExclusionHole } from "./authority-database-process.js";
import { applyLocalObservationRetention } from "./local-observation-retention.js";
import { recoverLocalRetentionOperations,
  type RetentionRecovery } from "./local-observation-retention-recovery.js";
import { applyRetentionCandidate } from "./local-observation-retention-swap.js";
import {
  parseLocalObservationRetentionConfig, resolveLocalObservationRetentionCutoff,
} from "./local-observation-retention-selection.js";

export type RetentionCycle =
  | { readonly status: "inactive" }
  | { readonly status: "deferred"; readonly next_at: string;
      readonly recovered: readonly RetentionRecovery[] }
  | { readonly status: "blocked"; readonly unfinished: number;
      readonly recovered: readonly RetentionRecovery[] }
  | { readonly status: "unsupported"; readonly reason: "no_swap_runtime";
      readonly recovered: readonly RetentionRecovery[] }
  | { readonly status: "processed"; readonly operation_id: string;
      readonly recorded_state: string; readonly result_generation: number;
      readonly removed: Readonly<Record<string, number>>;
      readonly recovered: readonly RetentionRecovery[] }
  | { readonly status: "failed"; readonly code: string;
      readonly recovered: readonly RetentionRecovery[] }
  /**
   * The environment could not answer who holds the source, so nothing was replaced.
   *
   * Its own outcome rather than a failure: nothing is broken, the answer is incomplete, and the
   * operator needs to know which processes could not be read before they can do anything about it.
   * It is also not blocked or deferred - there is no unfinished work to wait for and no window to
   * wait out, because the same kernel will give the same answer.
   */
  | { readonly status: "unprovable"; readonly reason: string;
      readonly unreadable_processes: readonly number[];
      readonly recovered: readonly RetentionRecovery[] };

type ServiceOptions = {
  readonly config_path?: string;
  readonly runtime?: AuthorityDatabaseRuntime;
  readonly interval_ms: number;
  readonly clock?: () => Date;
};

const COUNTED = ["observation", "context", "recommendation"] as const;

/**
 * Opt-in scheduled retention. Without a configuration document it is inactive, and without a
 * runtime to quiesce and swap behind it reports that it cannot apply rather than building a
 * candidate it could never install. What it returns describes this cycle; the durable record of a
 * completed rebuild is the operation row, which is read back here rather than assumed.
 */
export class LocalObservationRetentionService {
  private readonly clock: () => Date;

  constructor(
    private readonly authority: AuthorityDb,
    private readonly options: ServiceOptions,
  ) {
    if (!Number.isSafeInteger(options.interval_ms) || options.interval_ms < 60_000
      || options.interval_ms > 86_400_000) throw new JarvisError("LOCAL_RETENTION_SCHEDULE_INVALID");
    this.clock = options.clock ?? (() => new Date());
  }

  async cycle(): Promise<RetentionCycle> {
    if (this.options.config_path === undefined) return { status: "inactive" };
    const config = parseLocalObservationRetentionConfig(
      readRetentionConfig(this.options.config_path));
    const now = this.clock();
    // Recovery runs before the window is consulted. A process that died holding a claim would
    // otherwise leave its candidate unexplained until the next window opened, which the allowed
    // interval lets stretch to a day.
    const recovered = recoverLocalRetentionOperations(this.authority, now);
    const claim = this.claim(now);
    if (claim !== undefined) return { status: "deferred", next_at: claim, recovered };
    const unfinished = Number(this.authority.db.prepare(
      "SELECT COUNT(*) FROM local_retention_operations WHERE state IN ('preparing','verified')")
      .pluck().get());
    if (unfinished > 0) return { status: "blocked", unfinished, recovered };
    const runtime = this.options.runtime;
    if (runtime === undefined) return { status: "unsupported", reason: "no_swap_runtime", recovered };
    const cutoff = resolveLocalObservationRetentionCutoff(config, now);
    try {
      return await this.rebuild(runtime, cutoff, now, recovered);
    } catch (error) {
      if (error instanceof JarvisError && error.code === "LOCAL_RETENTION_EXCLUSION_UNPROVABLE") {
        const hole = parseExclusionHole(
          error.message.replace(/^LOCAL_RETENTION_EXCLUSION_UNPROVABLE:\s*/, ""));
        return { status: "unprovable", reason: hole.reason,
          unreadable_processes: hole.unreadable_processes, recovered };
      }
      return { status: "failed", recovered,
        code: error instanceof Error ? error.message : "LOCAL_RETENTION_CYCLE_FAILED" };
    }
  }

  private async rebuild(
    runtime: AuthorityDatabaseRuntime, cutoff: string, now: Date,
    recovered: readonly RetentionRecovery[],
  ): Promise<RetentionCycle> {
    const application = await applyLocalObservationRetention(
      this.authority, cutoff, `${this.authority.filename}.retention-candidate`, now);
    const swap = await runtime.quiesce("local_retention",
      async () => applyRetentionCandidate(runtime, application, now));
    const removed = Object.fromEntries(COUNTED.map(kind =>
      [kind, application.selection.blocked.filter(item => item.kind === kind).length]));
    // Read the stage back out of the database that is now live; the call returning is not it.
    const recordedState = String(this.authority.db.prepare(
      "SELECT state FROM local_retention_operations WHERE operation_id=?")
      .pluck().get(swap.operation_id));
    return { status: "processed", operation_id: swap.operation_id, recorded_state: recordedState,
      result_generation: swap.result_generation, removed, recovered };
  }

  /** Claims this cycle's window, or returns the instant the next one opens. */
  private claim(now: Date): string | undefined {
    const at = now.toISOString();
    const next = new Date(now.getTime() + this.options.interval_ms).toISOString();
    return this.authority.db.transaction((): string | undefined => {
      const current = this.authority.db.prepare(
        "SELECT next_at FROM local_retention_cycle_fence WHERE fence_id=1").pluck().get();
      if (typeof current === "string" && at < current) return current;
      this.authority.db.prepare(
        `INSERT INTO local_retention_cycle_fence(fence_id,next_at,claimed_at) VALUES(1,?,?)
         ON CONFLICT(fence_id) DO UPDATE SET next_at=excluded.next_at,claimed_at=excluded.claimed_at`)
        .run(next, at);
      return undefined;
    })();
  }
}
