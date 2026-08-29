import type Database from "better-sqlite3";
import { persistenceRow, persistenceText } from "./personal-persistence-values.js";

export type RecommendationLifecycleState = "pending" | "accepted" | "rejected" | "expired" | "superseded";
export type ProjectedRecommendationAction = {
  readonly recommendation_id: string;
  readonly context_id: string;
  readonly context_digest: string;
  readonly canonical_digest: string;
  readonly evidence_digest: string;
  readonly rank: number;
  readonly title: string;
  readonly operation: string;
  readonly target_digest: string;
  readonly approval_requirement: "none" | "owner";
  readonly confidence_class: "low" | "medium" | "high";
  readonly owner_decision_required: boolean;
  readonly state: RecommendationLifecycleState;
  readonly current: boolean;
  readonly executable: false;
  readonly expires_at: string;
};
export type RecommendationWarning = {
  readonly recommendation_id: string;
  readonly code: "RECOMMENDATION_EXPIRED" | "RECOMMENDATION_STALE";
  readonly deadline: string;
};
export type RecommendationReadProjection = {
  readonly generated_at: string;
  readonly next_actions: readonly ProjectedRecommendationAction[];
  readonly owner_decisions_needed: readonly ProjectedRecommendationAction[];
  readonly conflicts: readonly string[];
  readonly omissions: readonly string[];
  readonly warnings: readonly RecommendationWarning[];
};

type EnvelopeSummary = {
  readonly conflicts: readonly string[];
  readonly omissions: readonly string[];
  readonly ownerRanks: ReadonlySet<number>;
};

function summary(value: unknown): EnvelopeSummary {
  if (typeof value !== "string") return { conflicts: [], omissions: [], ownerRanks: new Set() };
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { conflicts: [], omissions: [], ownerRanks: new Set() };
  const payload = Reflect.get(parsed, "payload");
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { conflicts: [], omissions: [], ownerRanks: new Set() };
  const conflicts = Reflect.get(payload, "conflicts"); const omissions = Reflect.get(payload, "omissions");
  const confidence = Reflect.get(payload, "confidence_basis");
  let ownerRanks: ReadonlySet<number> = new Set();
  if (typeof confidence === "string") {
    const ranking: unknown = JSON.parse(confidence);
    const actions = typeof ranking === "object" && ranking !== null ? Reflect.get(ranking, "actions") : undefined;
    if (Array.isArray(actions)) ownerRanks = new Set(actions.filter(item => typeof item === "object" && item !== null
      && Reflect.get(item, "disposition") === "owner_gate_required").map(item => Number(Reflect.get(item, "rank"))));
  }
  return { conflicts: Array.isArray(conflicts) ? conflicts.filter((item): item is string => typeof item === "string") : [],
    omissions: Array.isArray(omissions) ? omissions.filter((item): item is string => typeof item === "string") : [], ownerRanks };
}

function lifecycle(value: unknown): RecommendationLifecycleState {
  const state = persistenceText(value);
  switch (state) {
    case "pending": case "accepted": case "rejected": case "expired": case "superseded": return state;
    default: throw new TypeError("stored recommendation lifecycle required");
  }
}

export function projectRecommendations(
  database: Database.Database,
  now: string,
  limit = 100,
): RecommendationReadProjection {
  const maximum = Math.min(500, Math.max(1, Math.trunc(limit)));
  const rows = database.prepare(
    `SELECT r.recommendation_id,r.context_id,r.context_digest,r.canonical_digest,r.evidence_digest,
            r.approval_requirement,r.confidence_class,r.expires_at,r.canonical_envelope_json,
            c.expires_at AS context_expires_at,c.fresh_until AS context_fresh_until,
            a.rank,a.title,a.operation,a.target_digest,
            (SELECT state FROM personal_recommendation_action_events e
             WHERE e.recommendation_id=a.recommendation_id AND e.rank=a.rank
             ORDER BY event_sequence DESC LIMIT 1) AS state
     FROM personal_recommendations r
     JOIN personal_context_snapshots c ON c.context_id=r.context_id
     JOIN personal_recommendation_actions a ON a.recommendation_id=r.recommendation_id
     ORDER BY r.created_at DESC,r.recommendation_id,a.rank LIMIT ?`,
  ).all(maximum).map(persistenceRow);
  const envelopes = new Map<string, EnvelopeSummary>();
  for (const row of rows) {
    const recommendationId = persistenceText(row["recommendation_id"]);
    if (!envelopes.has(recommendationId)) envelopes.set(recommendationId, summary(row["canonical_envelope_json"]));
  }
  const actions = rows.map(row => {
    const state = lifecycle(row["state"]); const rank = Number(row["rank"]); const recommendationId = persistenceText(row["recommendation_id"]);
    const deadline = [persistenceText(row["expires_at"]), persistenceText(row["context_expires_at"]), persistenceText(row["context_fresh_until"])].sort()[0];
    if (deadline === undefined) throw new TypeError("stored recommendation deadline required");
    const current = (state === "pending" || state === "accepted") && now < deadline;
    return {
      recommendation_id: persistenceText(row["recommendation_id"]), context_id: persistenceText(row["context_id"]),
      context_digest: persistenceText(row["context_digest"]), canonical_digest: persistenceText(row["canonical_digest"]),
      evidence_digest: persistenceText(row["evidence_digest"]), rank, title: persistenceText(row["title"]),
      operation: persistenceText(row["operation"]), target_digest: persistenceText(row["target_digest"]),
      approval_requirement: persistenceText(row["approval_requirement"]) === "owner" ? "owner" as const : "none" as const,
      confidence_class: persistenceText(row["confidence_class"]) === "high"
        ? "high" as const
        : persistenceText(row["confidence_class"]) === "medium" ? "medium" as const : "low" as const,
      owner_decision_required: envelopes.get(recommendationId)?.ownerRanks.has(rank) ?? false,
      state, current, executable: false as const, expires_at: deadline,
    };
  });
  const current = actions.filter(action => action.current).sort((left, right) => (
    left.rank - right.rank || left.recommendation_id.localeCompare(right.recommendation_id)
  ));
  const warnings = [...new Map(rows.flatMap(row => {
    const recommendationId = persistenceText(row["recommendation_id"]);
    const expires = [persistenceText(row["expires_at"]), persistenceText(row["context_expires_at"])].sort()[0];
    const fresh = persistenceText(row["context_fresh_until"]);
    const warning = now >= (expires ?? fresh)
      ? { recommendation_id: recommendationId, code: "RECOMMENDATION_EXPIRED" as const, deadline: expires ?? fresh }
      : now >= fresh ? { recommendation_id: recommendationId, code: "RECOMMENDATION_STALE" as const, deadline: fresh } : undefined;
    return warning === undefined ? [] : [[`${warning.recommendation_id}:${warning.code}`, warning] as const];
  })).values()].sort((left, right) => left.deadline.localeCompare(right.deadline) || left.recommendation_id.localeCompare(right.recommendation_id));
  return {
    generated_at: now, next_actions: current,
    owner_decisions_needed: current.filter(action => action.owner_decision_required && action.state === "pending"),
    conflicts: [...new Set([...envelopes.values()].flatMap(item => item.conflicts))].sort(),
    omissions: [...new Set([...envelopes.values()].flatMap(item => item.omissions))].sort(), warnings,
  };
}
