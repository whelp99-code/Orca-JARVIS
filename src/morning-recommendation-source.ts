import type { AuthorityDb } from "./db.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { storedRecommendationIdentity, type RecommendationIdentity } from "./recommendation-identity.js";
import { validateStoredRecommendationEvents } from "./recommendation-transition-identity.js";
import { deriveRecommendationEvidenceLinks } from "./recommendation-evidence-binding.js";
import { contextsWithUnavailableLocalSource } from "./local-observation-availability.js";
import { contextsWithClosedMemorySource } from "./personal-memory-availability.js";
import { persistenceRow } from "./personal-persistence-values.js";
import { instant, integer } from "./morning-brief-parse-values.js";
import { parseMorningBriefInput } from "./morning-brief-input.js";
import { generateMorningBrief } from "./morning-brief-generator.js";
import { verifyMorningBriefResult } from "./morning-brief-artifact.js";
import type { MorningBriefInput, MorningBriefRecord, MorningBriefResult } from "./morning-brief-types.js";
import { invalidMorningSource, MorningRecommendationSourceError, readMorningRecommendationContext } from "./morning-recommendation-context.js";
import { morningRecommendationRecord } from "./morning-recommendation-record.js";

export { MorningRecommendationSourceError } from "./morning-recommendation-context.js";
export type MorningRecommendationLineage = {
  readonly context_id: string; readonly recommendation_id: string; readonly rank: number;
  readonly action_id: string; readonly identity_digest: string;
};
export type MorningRecommendationSnapshot = {
  readonly input: MorningBriefInput;
  readonly lineage: readonly MorningRecommendationLineage[];
  readonly excluded: {
    readonly legacy_ranking: number; readonly source_unavailable: number;
    readonly stale_deadline: number; readonly inactive: number;
  };
  readonly source_capped: boolean;
};
type Candidate = { readonly recommendation_id: string; readonly context_id: string; readonly rank: number };
type Source = { readonly identity: RecommendationIdentity; readonly context: ReturnType<typeof readMorningRecommendationContext> };

/** Reads advisory recommendation sources only. The caller must revalidate lineage when publishing. */
export class MorningRecommendationSource {
  constructor(private readonly authority: AuthorityDb) {}

  read(nowValue: unknown, maxActionsValue: unknown = 256): MorningRecommendationSnapshot {
    try {
      const now = instant(nowValue); const maximum = integer(maxActionsValue, 1, 256);
      return this.authority.db.transaction(() => this.snapshot(now, maximum)).deferred();
    } catch { throw new MorningRecommendationSourceError(); }
  }

  generate(nowValue: unknown, maxActionsValue: unknown = 256): {
    readonly source: MorningRecommendationSnapshot; readonly brief: MorningBriefResult;
  } {
    const source = this.read(nowValue, maxActionsValue);
    return { source, brief: verifyMorningBriefResult(generateMorningBrief(source.input)) };
  }

  private candidates(maximum: number): readonly Candidate[] {
    return this.authority.db.prepare(
      `SELECT r.recommendation_id,r.context_id,a.rank
       FROM personal_recommendations r JOIN personal_recommendation_actions a ON a.recommendation_id=r.recommendation_id
       WHERE NOT EXISTS (
         SELECT 1 FROM memory_projection_suppressions s
         WHERE (s.projection_kind='context' AND s.projection_id=r.context_id)
           OR (s.projection_id=r.recommendation_id AND (s.projection_kind='recommendation'
             OR (s.projection_kind='recommendation_action' AND s.component_id=CAST(a.rank AS TEXT)))))
       AND NOT EXISTS (
         SELECT 1 FROM memory_projection_quarantine q
         WHERE (q.projection_kind='context' AND q.projection_id=r.context_id)
           OR (q.projection_id=r.recommendation_id AND (q.projection_kind='recommendation'
             OR (q.projection_kind='recommendation_action' AND q.component_id=CAST(a.rank AS TEXT)))))
       ORDER BY r.created_at DESC,r.recommendation_id,a.rank LIMIT ?`,
    ).all(maximum + 1) as Candidate[];
  }

  private identity(id: string, visibleRanks: readonly number[]): RecommendationIdentity {
    const row = persistenceRow(this.authority.db.prepare("SELECT canonical_digest,evidence_digest,canonical_envelope_json "
      + "FROM personal_recommendations WHERE recommendation_id=?").get(id));
    const identity = storedRecommendationIdentity(row["canonical_digest"], row["evidence_digest"], row["canonical_envelope_json"]);
    validateStoredRecommendationEvents(this.authority.db, identity, row["evidence_digest"], id, visibleRanks);
    return identity;
  }

  private source(identity: RecommendationIdentity, now: string): Source {
    const context = readMorningRecommendationContext(this.authority.db, identity, now);
    const provenance = identity.provenance;
    deriveRecommendationEvidenceLinks({ authority: this.authority, contextId: context.id,
      contextDigest: identity.recommendation.payload.context_digest, result: provenance.ranking,
      actions: provenance.ranking.actions.filter(action => action.rank !== null), supplied: provenance.linux_evidence });
    return { identity, context };
  }

  private snapshot(now: string, maximum: number): MorningRecommendationSnapshot {
    new MemoryProjectionAuthority(this.authority).assertReady();
    const candidates = this.candidates(maximum);
    const identities = new Map<string, RecommendationIdentity>(); const sources = new Map<string, Source>();
    const records: MorningBriefRecord[] = []; const lineage: MorningRecommendationLineage[] = [];
    const excluded = { legacy_ranking: 0, source_unavailable: 0, stale_deadline: 0, inactive: 0 };
    // A replaced or held local source excludes its own recommendation, like a quarantined one,
    // instead of failing every other publishable recommendation in the same read.
    const contextIds = [...new Set(candidates.slice(0, maximum).map(candidate => candidate.context_id))];
    // A hidden task takes its derived memory out of the brief for the same reason a replaced local
    // snapshot does: the source the recommendation rests on is not available to it any more.
    const unavailable = new Set([...contextsWithUnavailableLocalSource(this.authority.db, contextIds, now),
      ...contextsWithClosedMemorySource(this.authority, contextIds)]);
    let degraded = candidates.length > maximum;
    for (const candidate of candidates.slice(0, maximum)) {
      if (unavailable.has(candidate.context_id)) { excluded.source_unavailable++; continue; }
      let identity = identities.get(candidate.recommendation_id);
      if (identity === undefined) {
        identity = this.identity(candidate.recommendation_id, candidates.slice(0, maximum)
          .filter(item => item.recommendation_id === candidate.recommendation_id).map(item => item.rank));
        identities.set(candidate.recommendation_id, identity);
      }
      const recommendation = identity.recommendation;
      const state = this.authority.db.prepare("SELECT state,occurred_at AS recorded_at,COALESCE(transition_occurred_at,occurred_at) AS occurred_at "
        + "FROM personal_recommendation_action_events WHERE recommendation_id=? AND rank=? ORDER BY event_sequence DESC LIMIT 1")
        .get(candidate.recommendation_id, candidate.rank) as { state: string; occurred_at: string; recorded_at: string };
      if (!["eligible", "presented", "selected"].includes(recommendation.payload.state)
        || !["pending", "accepted"].includes(state.state) || recommendation.created_at > now
        || state.occurred_at > now || state.recorded_at > now || recommendation.freshness.checked_at > now
        || recommendation.valid_at > now || recommendation.freshness.state !== "fresh"
        || recommendation.freshness.fresh_until <= now || recommendation.expires_at <= now) { excluded.inactive++; continue; }
      const ranking = identity.provenance.ranking;
      if (ranking.schema_version !== 2) { excluded.legacy_ranking++; continue; }
      const decision = ranking.actions.find(action => action.rank === candidate.rank);
      const deadline = ranking.deadline_evidence.find(item => item.action_id === decision?.action_id);
      if (decision === undefined || deadline === undefined || recommendation.payload.context_id !== candidate.context_id) return invalidMorningSource();
      if (ranking.generated_at > now) return invalidMorningSource();
      if (deadline.deadline !== null && deadline.deadline.fresh_until <= now) { excluded.stale_deadline++; continue; }
      let source = sources.get(candidate.recommendation_id);
      if (source === undefined) { source = this.source(identity, now); sources.set(candidate.recommendation_id, source); }
      const context = source.context;
      if (context.payload.state !== "sufficient" || context.freshness.state !== "fresh" || context.freshness.fresh_until <= now
        || context.expires_at <= now) { excluded.inactive++; continue; }
      degraded ||= context.payload.conflicts.length > 0 || context.payload.omissions.length > 0;
      records.push(morningRecommendationRecord(identity, context, decision, state.state, deadline.deadline, now));
      lineage.push({ context_id: context.id, recommendation_id: recommendation.id, rank: candidate.rank,
        action_id: decision.action_id, identity_digest: identity.identity_digest });
    }
    degraded ||= Object.values(excluded).some(count => count > 0);
    return { input: parseMorningBriefInput({ schema_version: 1, generated_at: now,
      context_readiness: candidates.length === 0 ? "no_data" : degraded ? "degraded" : "ready",
      external_intelligence: { enabled: false, state: "off" }, limits: null, items: records }),
    lineage, excluded, source_capped: candidates.length > maximum };
  }
}
