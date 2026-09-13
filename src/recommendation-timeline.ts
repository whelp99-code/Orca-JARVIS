import { AuthorityDb, JarvisError } from "./db.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { persistenceRow, persistenceText } from "./personal-persistence-values.js";
import { projectRecommendations } from "./recommendation-projection.js";
import { storedRecommendationIdentity } from "./recommendation-identity.js";
import { validateStoredRecommendationEvents } from "./recommendation-transition-identity.js";
import { TaskTimelinePopulation, activeTaskState } from "./task-timeline-population.js";
import {
  TaskTimeline as BaseTaskTimeline,
  type TaskTimelineContext as BaseContext,
  type TaskTimelineEvent as BaseEvent,
  type TaskTimelineKind as BaseKind,
  type TaskTimelineSource as BaseSource,
  type TaskTimelineSummary as BaseSummary,
} from "./task-timeline.js";

export type TaskTimelineSource = BaseSource | "recommendation";
export type TaskTimelineKind = BaseKind | "recommendation";
export type TaskTimelineSummary = Omit<BaseSummary, "kind"> & {
  readonly kind: BaseSummary["kind"] | "recommendation";
};
export type TaskTimelineEvent = Omit<BaseEvent, "source" | "kind"> & {
  readonly source: TaskTimelineSource;
  readonly kind: TaskTimelineKind;
};
export type TaskTimelineContext = Omit<BaseContext, "task" | "events"> & {
  readonly task: TaskTimelineSummary;
  readonly events: readonly TaskTimelineEvent[];
};
type Row = Readonly<Record<string, unknown>>;
const compareText = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));
function ownerRanks(row: Row): ReadonlySet<number> {
  const identity = storedRecommendationIdentity(row["canonical_digest"], row["evidence_digest"], row["canonical_envelope_json"]);
  if (typeof identity.provenance !== "object" || identity.provenance === null || Array.isArray(identity.provenance)) return new Set();
  const ranking = Reflect.get(identity.provenance, "ranking");
  if (typeof ranking !== "object" || ranking === null || Array.isArray(ranking)) return new Set();
  const actions = Reflect.get(ranking, "actions");
  return new Set(Array.isArray(actions) ? actions.flatMap(action => {
    if (typeof action !== "object" || action === null || Array.isArray(action)
      || Reflect.get(action, "disposition") !== "owner_gate_required") return [];
    const rank = Reflect.get(action, "rank"); return typeof rank === "number" ? [rank] : [];
  }) : []);
}
function validateEvents(database: AuthorityDb["db"], row: Row): void {
  const source = storedRecommendationIdentity(row["canonical_digest"], row["evidence_digest"], row["canonical_envelope_json"]);
  validateStoredRecommendationEvents(database, source, row["evidence_digest"], persistenceText(row["recommendation_id"]));
}
function recommendationSummary(row: Row): TaskTimelineSummary {
  const ranks = ownerRanks(row);
  const states: unknown = JSON.parse(persistenceText(row["states_json"]));
  const pending = Array.isArray(states) && states.some(item => typeof item === "object" && item !== null
    && ranks.has(Number(Reflect.get(item, "rank"))) && Reflect.get(item, "state") === "pending");
  const latestState = persistenceText(row["latest_state"]);
  const remaining = Array.isArray(states) ? states.map(item => persistenceText(persistenceRow(item)["state"]))
    .find(activeTaskState) : undefined;
  const state = activeTaskState(latestState) ? latestState : remaining ?? latestState;
  return {
    task_id: persistenceText(row["recommendation_id"]), title: persistenceText(row["title"]), kind: "recommendation",
    state, updated_at: persistenceText(row["updated_at"]),
    pending_approval: pending, source_ids: [persistenceText(row["recommendation_id"])],
  };
}
const SUMMARY_SQL = `SELECT r.recommendation_id,r.canonical_digest,r.evidence_digest,r.canonical_envelope_json,
  (SELECT title FROM personal_recommendation_actions a WHERE a.recommendation_id=r.recommendation_id ORDER BY rank LIMIT 1) AS title,
  (SELECT state FROM personal_recommendation_action_events e WHERE e.recommendation_id=r.recommendation_id
   ORDER BY event_sequence DESC LIMIT 1) AS latest_state,
  (SELECT COALESCE(transition_occurred_at,occurred_at) FROM personal_recommendation_action_events e
   WHERE e.recommendation_id=r.recommendation_id ORDER BY event_sequence DESC LIMIT 1) AS updated_at,
  (SELECT json_group_array(json_object('rank',rank,'state',state)) FROM
    (SELECT a.rank,(SELECT state FROM personal_recommendation_action_events e WHERE e.recommendation_id=a.recommendation_id
     AND e.rank=a.rank ORDER BY event_sequence DESC LIMIT 1) AS state FROM personal_recommendation_actions a
     WHERE a.recommendation_id=r.recommendation_id ORDER BY a.rank)) AS states_json
  FROM personal_recommendations r`;

export class TaskTimeline {
  private readonly base: BaseTaskTimeline;
  constructor(private readonly authority: AuthorityDb) { this.base = new BaseTaskTimeline(authority); }

  list(limit = 100): TaskTimelineSummary[] {
    return this.overview(limit).recent;
  }

  overview(limit = 20): { recent: TaskTimelineSummary[]; activeCount: number } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new JarvisError("TASK_TIMELINE_INVALID");
    return this.authority.db.transaction(() => {
      const projections = new MemoryProjectionAuthority(this.authority);
      projections.assertReady();
      const population = new TaskTimelinePopulation(this.authority);
      const base = population.overview(limit, true);
      const recent: TaskTimelineSummary[] = base.recent;
      let activeCount = base.activeCount;
      const rows = population.recommendationRows(SUMMARY_SQL);
      for (const value of rows) {
        const row = persistenceRow(value);
        validateEvents(this.authority.db, row);
        const recommendation = recommendationSummary(row);
        if (activeTaskState(recommendation.state)) activeCount++;
        recent.push(recommendation);
        recent.sort((left, right) => compareText(right.updated_at, left.updated_at) || compareText(left.task_id, right.task_id));
        if (recent.length > limit) recent.pop();
      }
      return { recent, activeCount };
    }).deferred();
  }

  timeline(taskId: string, limit = 200): TaskTimelineEvent[] {
    return this.authority.db.transaction(() => this.readTimeline(taskId, limit)).deferred();
  }

  private readTimeline(taskId: string, limit: number): TaskTimelineEvent[] {
    if (new TaskTimelinePopulation(this.authority).isSuppressed(taskId)) {
      throw new JarvisError("TASK_TIMELINE_NOT_FOUND");
    }
    const canonicalId = new TaskTimelinePopulation(this.authority).find(taskId)?.task_id ?? taskId;
    const exists = this.authority.db.prepare(
      "SELECT recommendation_id,canonical_digest,evidence_digest,canonical_envelope_json FROM personal_recommendations WHERE recommendation_id=?",
    ).get(canonicalId);
    if (exists === undefined) return this.base.timeline(taskId, limit);
    taskId = canonicalId;
    validateEvents(this.authority.db, persistenceRow(exists));
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new JarvisError("TASK_TIMELINE_INVALID");
    return this.authority.db.prepare(
      `SELECT e.event_sequence,e.rank,e.state,e.evidence_digest,
              COALESCE(e.transition_occurred_at,e.occurred_at) AS transition_occurred_at,
              e.occurred_at AS recorded_at,e.transition_digest,e.replacement_recommendation_id,
              a.title,a.operation,a.target_digest,r.context_id,r.context_digest,r.canonical_digest,
              r.approval_requirement,r.confidence_class
       FROM personal_recommendation_action_events e
       JOIN personal_recommendation_actions a ON a.recommendation_id=e.recommendation_id AND a.rank=e.rank
       JOIN personal_recommendations r ON r.recommendation_id=e.recommendation_id
       WHERE e.recommendation_id=? ORDER BY e.event_sequence DESC LIMIT ?`,
    ).all(taskId, limit).map(persistenceRow).reverse().map((row, index) => ({
      event_id: `recommendation:${taskId}:${String(row["event_sequence"])}`, task_id: taskId,
      source: "recommendation", kind: "recommendation", actor: "jarvis-recommendations",
      title: persistenceText(row["title"]), status: persistenceText(row["state"]),
      payload: { rank: row["rank"], operation: row["operation"], target_digest: row["target_digest"],
        context_id: row["context_id"], context_digest: row["context_digest"], canonical_digest: row["canonical_digest"],
        approval_requirement: row["approval_requirement"], confidence_class: row["confidence_class"],
        recorded_at: row["recorded_at"], transition_digest: row["transition_digest"],
        replacement_recommendation_id: row["replacement_recommendation_id"],
        authority: "none", executable: false }, evidence_refs: [persistenceText(row["evidence_digest"])],
      created_at: persistenceText(row["transition_occurred_at"]), sequence: index + 1,
    }));
  }

  context(taskId: string, limit = 100, maxBytes = 128 * 1024, now = new Date()): TaskTimelineContext {
    return this.authority.db.transaction(() => this.readContext(taskId, limit, maxBytes, now)).deferred();
  }

  private readContext(taskId: string, limit: number, maxBytes: number, now: Date): TaskTimelineContext {
    if (new TaskTimelinePopulation(this.authority).isSuppressed(taskId)) {
      throw new JarvisError("TASK_TIMELINE_NOT_FOUND");
    }
    const canonicalId = new TaskTimelinePopulation(this.authority).find(taskId)?.task_id ?? taskId;
    const value = this.authority.db.prepare(`${SUMMARY_SQL} WHERE r.recommendation_id=?`).get(canonicalId);
    if (value === undefined) return this.base.context(taskId, limit, maxBytes, now);
    taskId = canonicalId;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
      throw new JarvisError("TASK_TIMELINE_INVALID");
    }
    const task = recommendationSummary(persistenceRow(value)); const events = this.timeline(taskId, limit);
    const decisions = projectRecommendations(this.authority, now.toISOString(), 500).owner_decisions_needed
      .filter(action => action.recommendation_id === taskId).map(action => ({ kind: "recommendation", ...action }));
    return { schema_version: 1, generated_at: now.toISOString(), task, events, pending_decisions: decisions,
      workers: [], evidence: [], truncated: false };
  }
}
