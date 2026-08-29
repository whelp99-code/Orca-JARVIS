import type Database from "better-sqlite3";
import type { Sha256Digest } from "./personal-contracts.js";
import { persistenceHash, persistenceRow, persistenceText } from "./personal-persistence-values.js";
import { storedRecommendationIdentity } from "./recommendation-identity.js";

export type RecommendationLifecycleState = "pending" | "accepted" | "rejected" | "expired" | "superseded";
export type ProjectedEvidenceLink = {
  readonly ref: string;
  readonly kind: string;
  readonly context_evidence_id: string | null;
  readonly digest: string;
};
export type ProjectedRecommendationAction = {
  readonly recommendation_id: string;
  readonly context_id: string;
  readonly context_digest: string;
  readonly canonical_digest: string;
  readonly context_evidence_digest: string;
  readonly evidence_digest: string;
  readonly identity_digest: Sha256Digest;
  readonly provenance_digest: Sha256Digest;
  readonly evidence_links: readonly ProjectedEvidenceLink[];
  readonly rank: number;
  readonly title: string;
  readonly operation: string;
  readonly target_digest: string;
  readonly approval_requirement: "none" | "owner";
  readonly confidence_class: "low" | "medium" | "high";
  readonly owner_decision_required: boolean;
  readonly state: RecommendationLifecycleState;
  readonly replacement_recommendation_id: string | null;
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
  readonly lifecycle_actions: readonly ProjectedRecommendationAction[];
  readonly owner_decisions_needed: readonly ProjectedRecommendationAction[];
  readonly conflicts: readonly string[];
  readonly omissions: readonly string[];
  readonly warnings: readonly RecommendationWarning[];
};
type EnvelopeSummary = {
  readonly conflicts: readonly string[];
  readonly omissions: readonly string[];
  readonly ownerRanks: ReadonlySet<number>;
  readonly linksByRank: ReadonlyMap<number, readonly ProjectedEvidenceLink[]>;
  readonly identity: ReturnType<typeof storedRecommendationIdentity>;
};
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("stored object required");
  return Object.fromEntries(Object.entries(value));
}
function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function summary(row: Readonly<Record<string, unknown>>): EnvelopeSummary {
  const envelope = record(JSON.parse(persistenceText(row["canonical_envelope_json"])));
  const payload = record(envelope["payload"]);
  const identity = storedRecommendationIdentity(row["canonical_digest"], row["evidence_digest"], row["canonical_envelope_json"]);
  const provenance = record(identity.provenance);
  const ranking = record(provenance["ranking"]);
  const actions = Array.isArray(ranking["actions"]) ? ranking["actions"].map(record) : [];
  const links = Array.isArray(provenance["linux_evidence"])
    ? provenance["linux_evidence"].map(record).map(link => ({
        ref: persistenceText(link["ref"]), kind: persistenceText(link["kind"]),
        context_evidence_id: link["context_evidence_id"] === null ? null : persistenceText(link["context_evidence_id"]),
        digest: persistenceText(link["digest"]),
      }))
    : [];
  const ownerRanks = new Set(actions.filter(action => action["disposition"] === "owner_gate_required")
    .map(action => Number(action["rank"])));
  const linksByRank = new Map<number, readonly ProjectedEvidenceLink[]>();
  for (const action of actions) {
    const rationale = record(action["rationale"]); const citations = record(rationale["citations"]);
    const refs = new Set(Object.values(citations).filter((value): value is string => typeof value === "string"));
    linksByRank.set(Number(action["rank"]), links.filter(link => refs.has(link.ref)));
  }
  return { conflicts: stringList(payload["conflicts"]), omissions: stringList(payload["omissions"]),
    ownerRanks, linksByRank, identity };
}
function lifecycle(value: unknown): RecommendationLifecycleState {
  const state = persistenceText(value);
  switch (state) {
    case "pending": case "accepted": case "rejected": case "expired": case "superseded": return state;
    default: throw new TypeError("stored recommendation lifecycle required");
  }
}
function replacementId(
  row: Readonly<Record<string, unknown>>,
  candidates: readonly Readonly<Record<string, unknown>>[],
  summaries: ReadonlyMap<string, EnvelopeSummary>,
): string | null {
  if (row["state"] !== "superseded") return null;
  const originalEvidence = persistenceText(row["base_evidence_digest"]);
  const eventDigest = persistenceText(row["event_evidence_digest"]);
  for (const candidate of candidates) {
    const id = persistenceText(candidate["recommendation_id"]); const identity = summaries.get(id)?.identity.identity_digest;
    if (identity === undefined) continue;
    const expected = persistenceHash({ evidence_digest: originalEvidence,
      replacement_context_digest: persistenceText(candidate["context_digest"]),
      replacement_evidence_digest: persistenceText(candidate["evidence_digest"]),
      replacement_identity_digest: identity, replacement_recommendation_id: id });
    if (expected === eventDigest) return id;
  }
  return null;
}

export function projectRecommendations(database: Database.Database, now: string, limit = 100): RecommendationReadProjection {
  const rows = database.prepare(
    `SELECT r.recommendation_id,r.context_id,r.context_digest,r.canonical_digest,r.evidence_digest,
            r.evidence_digest AS base_evidence_digest,r.approval_requirement,r.confidence_class,r.expires_at,
            r.canonical_envelope_json,c.expires_at AS context_expires_at,c.fresh_until AS context_fresh_until,
            a.rank,a.title,a.operation,a.target_digest,
            (SELECT state FROM personal_recommendation_action_events e WHERE e.recommendation_id=a.recommendation_id
             AND e.rank=a.rank ORDER BY event_sequence DESC LIMIT 1) AS state,
            (SELECT evidence_digest FROM personal_recommendation_action_events e WHERE e.recommendation_id=a.recommendation_id
             AND e.rank=a.rank ORDER BY event_sequence DESC LIMIT 1) AS event_evidence_digest
     FROM personal_recommendations r JOIN personal_context_snapshots c ON c.context_id=r.context_id
     JOIN personal_recommendation_actions a ON a.recommendation_id=r.recommendation_id
     ORDER BY r.created_at DESC,r.recommendation_id,a.rank LIMIT ?`,
  ).all(limit).map(persistenceRow);
  const candidateRows = database.prepare(
    "SELECT recommendation_id,context_digest,canonical_digest,evidence_digest,canonical_envelope_json FROM personal_recommendations",
  ).all().map(persistenceRow);
  const summaries = new Map<string, EnvelopeSummary>();
  for (const row of [...rows, ...candidateRows]) {
    const id = persistenceText(row["recommendation_id"]);
    if (!summaries.has(id)) summaries.set(id, summary(row));
  }
  const actions = rows.map(row => {
    const state = lifecycle(row["state"]); const rank = Number(row["rank"]); const id = persistenceText(row["recommendation_id"]);
    const deadline = [persistenceText(row["expires_at"]), persistenceText(row["context_expires_at"]),
      persistenceText(row["context_fresh_until"])].sort()[0];
    if (deadline === undefined) throw new TypeError("stored recommendation deadline required");
    const details = summaries.get(id); if (details === undefined) throw new TypeError("stored recommendation summary required");
    const current = (state === "pending" || state === "accepted") && now < deadline;
    const approval = persistenceText(row["approval_requirement"]);
    const confidence = persistenceText(row["confidence_class"]);
    return {
      recommendation_id: id, context_id: persistenceText(row["context_id"]), context_digest: persistenceText(row["context_digest"]),
      canonical_digest: persistenceText(row["canonical_digest"]), context_evidence_digest: persistenceText(row["evidence_digest"]),
      evidence_digest: persistenceText(row["evidence_digest"]),
      identity_digest: details.identity.identity_digest,
      provenance_digest: details.identity.provenance_digest,
      evidence_links: details.linksByRank.get(rank) ?? [], rank, title: persistenceText(row["title"]),
      operation: persistenceText(row["operation"]), target_digest: persistenceText(row["target_digest"]),
      approval_requirement: approval === "owner" ? "owner" as const : "none" as const,
      confidence_class: confidence === "high" ? "high" as const : confidence === "medium" ? "medium" as const : "low" as const,
      owner_decision_required: details.ownerRanks.has(rank), state,
      replacement_recommendation_id: replacementId(row, candidateRows, summaries), current, executable: false as const,
      expires_at: deadline,
    };
  });
  const current = actions.filter(action => action.current).sort((left, right) => left.rank - right.rank
    || left.recommendation_id.localeCompare(right.recommendation_id));
  const warnings = [...new Map(rows.flatMap(row => {
    const id = persistenceText(row["recommendation_id"]); const expires = [persistenceText(row["expires_at"]),
      persistenceText(row["context_expires_at"])].sort()[0]; const fresh = persistenceText(row["context_fresh_until"]);
    const warning = now >= (expires ?? fresh)
      ? { recommendation_id: id, code: "RECOMMENDATION_EXPIRED" as const, deadline: expires ?? fresh }
      : now >= fresh ? { recommendation_id: id, code: "RECOMMENDATION_STALE" as const, deadline: fresh } : undefined;
    return warning === undefined ? [] : [[`${id}:${warning.code}`, warning] as const];
  })).values()].sort((left, right) => left.deadline.localeCompare(right.deadline)
    || left.recommendation_id.localeCompare(right.recommendation_id));
  return { generated_at: now, next_actions: current,
    lifecycle_actions: [...actions].sort((left, right) => left.recommendation_id.localeCompare(right.recommendation_id)
      || left.rank - right.rank),
    owner_decisions_needed: current.filter(action => action.owner_decision_required && action.state === "pending"),
    conflicts: [...new Set([...summaries.values()].flatMap(item => item.conflicts))].sort(),
    omissions: [...new Set([...summaries.values()].flatMap(item => item.omissions))].sort(), warnings };
}
