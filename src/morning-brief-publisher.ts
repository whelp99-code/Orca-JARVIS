import type { AuthorityDb } from "./db.js";
import { canonicalize } from "./canonical.js";
import { parseDailyLoopClaim, parseDailyLoopInstant } from "./daily-loop-input.js";
import { assertDailyLoopIntegrity } from "./daily-loop-integrity.js";
import { DailyLoopStore } from "./daily-loop-store.js";
import { kstLocalDate } from "./daily-loop-time.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { generateMorningBrief } from "./morning-brief-generator.js";
import { verifyMorningBriefResult } from "./morning-brief-artifact.js";
import { MorningRecommendationSource } from "./morning-recommendation-source.js";
import { integer } from "./morning-brief-parse-values.js";
import { bindMorningPublication, morningPublicationDependencies, MorningPublicationError, rejectMorningPublication }
  from "./morning-publication-lineage.js";
import {
  beforeMorningAssemblyDeadline, citedMorningOperations, CITED_ACTION_CAP, morningRefreshReasons, persistCitedNotification,
  persistMorningOperatingBrief, refreshSubscriptionOnTime, type MorningAssemblyOptions, type MorningOperatingBrief,
} from "./morning-operating-brief.js";

export { MorningPublicationError } from "./morning-publication-lineage.js";
export type { MorningAssemblyOptions, MorningOperatingBrief } from "./morning-operating-brief.js";
export type MorningPublicationResult = {
  readonly published: boolean; readonly held: boolean; readonly brief_id: string | null;
  readonly source_items: number; readonly artifact_bytes: number; readonly operations: MorningOperatingBrief | null;
};

const unpublished = (held: boolean): MorningPublicationResult =>
  ({ published: false, held, brief_id: null, source_items: 0, artifact_bytes: 0, operations: null });

/** Local SQLite publication only. Assembly waits for the 07:00 refresh and stops waiting at 07:20. */
export class MorningBriefPublisher {
  constructor(private readonly authority: AuthorityDb, private readonly clock: () => Date = () => new Date(),
    private readonly assembly: MorningAssemblyOptions = {}) {}

  publish(claimValue: unknown, maxBytesValue: unknown, maxActionsValue: unknown = CITED_ACTION_CAP,
    refreshValue: unknown = null): MorningPublicationResult {
    try {
      const claim = parseDailyLoopClaim(claimValue);
      const maxBytes = integer(maxBytesValue, 1, 1_048_576);
      const maxActions = maxActionsValue === undefined ? CITED_ACTION_CAP : integer(maxActionsValue, 1, CITED_ACTION_CAP);
      return this.authority.db.transaction(() => {
        const at = parseDailyLoopInstant(this.clock()); const timestamp = at.toISOString();
        const subscribedAt = this.assembly.subscribedAt;
        const subscriptionOnTime = subscribedAt !== undefined && refreshSubscriptionOnTime(subscribedAt, at);
        const reasons = morningRefreshReasons(at, refreshValue, this.assembly.freshnessMs ?? 1_200_000, subscriptionOnTime);
        const refreshBlocking = reasons.some(reason => reason !== "refresh_subscription_late");
        if (subscriptionOnTime && beforeMorningAssemblyDeadline(at) && refreshBlocking) return unpublished(true);
        const projections = new MemoryProjectionAuthority(this.authority); projections.assertReady();
        assertDailyLoopIntegrity(this.authority, claim.run_id);
        const run = this.authority.db.prepare("SELECT * FROM daily_loop_runs WHERE run_id=?").get(claim.run_id) as
          Record<string, unknown> | undefined;
        if (run === undefined || run["record_version"] !== 1 || run["phase"] !== "morning"
          || run["loop_date"] !== kstLocalDate(at) || !["claimed", "running"].includes(String(run["state"]))
          || run["lease_owner"] !== claim.owner_id || run["lease_fence"] !== claim.fence
          || timestamp < String(run["created_at"]) || timestamp < String(run["updated_at"])
          || timestamp < String(run["not_before"])
          || timestamp >= String(run["lease_expires_at"]) || timestamp >= String(run["expires_at"])
          || run["lease_expires_at"] !== claim.lease_expires_at || run["expires_at"] !== claim.deadline_at
          || projections.isProjectionIdSuppressed(claim.run_id)) return rejectMorningPublication();
        const input = JSON.parse(String(run["input_json"]));
        if (input.phase !== run["phase"] || input.local_date !== run["loop_date"]) return rejectMorningPublication();
        const store = new DailyLoopStore(this.authority); const steps = store.steps(claim.run_id);
        if (!Array.isArray(input.steps) || input.steps.length !== steps.length
          || steps.some((item, index) => item.step_key !== input.steps[index]?.key
            || item.sequence !== input.steps[index]?.sequence)) return rejectMorningPublication();
        const candidates = steps.filter(item => item.step_key === "morning_reconcile");
        const step = candidates[0];
        if (candidates.length !== 1 || step === undefined
          || steps.some(item => item.sequence < step.sequence && item.state !== "completed")) return rejectMorningPublication();
        if (step.state === "completed") return unpublished(false);
        if (step.state !== "pending") return rejectMorningPublication();
        const source = new MorningRecommendationSource(this.authority).read(timestamp, 256);
        const ranked = verifyMorningBriefResult(generateMorningBrief(source.input));
        const cited = [...ranked.needs_you_first, ...ranked.waiting, ...ranked.fyi].slice(0, maxActions);
        const citedKeys = new Set(cited.flatMap(item => [item.action_id, ...item.contributing_action_ids]));
        const recommendationIds = new Set(cited.flatMap(item => [item.recommendation_id, ...item.contributing_recommendation_ids]));
        const items = source.input.items.filter(item => citedKeys.has(item.action_id)).slice(0, maxActions);
        if (cited.length > 0 && items.length === 0) return rejectMorningPublication();
        const brief = verifyMorningBriefResult(generateMorningBrief({ ...source.input, items }));
        const lineage = source.lineage.filter(item => recommendationIds.has(item.recommendation_id));
        if (cited.length > 0 && lineage.length === 0) return rejectMorningPublication();
        const bytes = Buffer.byteLength(canonicalize(brief));
        if (bytes > maxBytes) return rejectMorningPublication();
        const dependencies = morningPublicationDependencies(this.authority, lineage);
        const completedAt = parseDailyLoopInstant(this.clock());
        if (completedAt < at || kstLocalDate(completedAt) !== run["loop_date"]
          || items.some(item => completedAt.toISOString() >= item.fresh_until
            || completedAt.toISOString() >= item.valid_until)) return rejectMorningPublication();
        store.start(claim, completedAt);
        store.completeStep({ claim, step, detail: brief, at: completedAt });
        bindMorningPublication(this.authority, [
          { kind: "daily_run", id: claim.run_id, component_id: claim.run_id },
          { kind: "daily_step", id: step.step_id, component_id: step.step_id },
          { kind: "morning_brief", id: brief.brief_id, component_id: brief.brief_id },
        ], dependencies, completedAt);
        const operations = citedMorningOperations(this.authority, brief, completedAt, reasons, subscriptionOnTime);
        persistMorningOperatingBrief(this.authority, brief.brief_id, operations);
        persistCitedNotification(this.authority, brief, lineage, completedAt.toISOString());
        assertDailyLoopIntegrity(this.authority, claim.run_id);
        return { published: true, held: false, brief_id: brief.brief_id, source_items: items.length,
          artifact_bytes: bytes, operations };
      }).immediate();
    } catch { throw new MorningPublicationError(); }
  }
}
