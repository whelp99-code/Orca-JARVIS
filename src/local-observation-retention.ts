import type Database from "better-sqlite3";
import { JarvisError } from "./jarvis-error.js";
import { isPersistenceTime, persistenceText } from "./personal-persistence-values.js";

const LOCAL_TIMELINE_SOURCE = "src:pos:v1:task-timeline:local";

export type RetentionProjection = { readonly kind: "observation" | "context" | "recommendation";
  readonly id: string; readonly component_id: string };
export type RetentionRetained = { readonly observation_id: string;
  readonly reason: "context_cites_current_observation" | "notification_addresses_recommendation" };
export type LocalObservationRetentionSelection = {
  readonly cutoff: string;
  readonly blocked: readonly RetentionProjection[];
  readonly retained: readonly RetentionRetained[];
};

/**
 * Selects what a retention cutoff could remove. Read-only: it performs no deletion and
 * never opens a write. Applying the result is a separate step through the rebuild adapter,
 * which is the only sanctioned deletion path for this immutable lineage.
 *
 * The cutoff is inclusive, matching `expires_at<=cutoff`. An observation is retained rather
 * than selected when removing it would break material the caller did not ask to remove:
 * a citing context that also cites an observation still inside the window, or a
 * recommendation still addressed by a notification intent. That second case has no foreign
 * key and no index behind it, so the rebuild's integrity check cannot catch it.
 */
export function selectLocalObservationRetention(
  database: Database.Database, cutoffValue: unknown,
): LocalObservationRetentionSelection {
  if (typeof cutoffValue !== "string" || !isPersistenceTime(cutoffValue)) {
    throw new JarvisError("LOCAL_RETENTION_CUTOFF_INVALID");
  }
  const cutoff = cutoffValue;
  const expired = database.prepare(
    `SELECT observation_id FROM personal_observations
     WHERE source_id=? AND expires_at<=? ORDER BY expires_at,observation_id`,
  ).pluck().all(LOCAL_TIMELINE_SOURCE, cutoff).map(persistenceText);
  const citingContexts = database.prepare(
    "SELECT context_id FROM personal_context_observations WHERE observation_id=? ORDER BY context_id");
  const contextObservations = database.prepare(
    "SELECT observation_id FROM personal_context_observations WHERE context_id=? ORDER BY position");
  const contextRecommendations = database.prepare(
    "SELECT recommendation_id FROM personal_recommendations WHERE context_id=? ORDER BY recommendation_id");
  const addressingIntents = database.prepare(
    "SELECT COUNT(*) FROM notification_intents WHERE deep_link LIKE '%'||?||'%'").pluck();

  const blocked: RetentionProjection[] = [];
  const retained: RetentionRetained[] = [];
  const seen = new Set<string>();
  const add = (kind: RetentionProjection["kind"], id: string): void => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    blocked.push({ kind, id, component_id: id });
  };
  const expiredSet = new Set(expired);

  for (const observation of expired) {
    const contexts = citingContexts.pluck().all(observation).map(persistenceText);
    const group: RetentionProjection[] = [{ kind: "observation", id: observation, component_id: observation }];
    let hold: RetentionRetained["reason"] | undefined;
    for (const context of contexts) {
      // Removing a context would drop its links to observations still inside the window.
      if (contextObservations.pluck().all(context).map(persistenceText)
        .some(cited => !expiredSet.has(cited))) { hold = "context_cites_current_observation"; break; }
      const recommendations = contextRecommendations.pluck().all(context).map(persistenceText);
      // The reference lives percent-encoded inside deep_link, so match the encoded form.
      if (recommendations.some(id => Number(addressingIntents.get(encodeURIComponent(id))) > 0)) {
        hold = "notification_addresses_recommendation"; break;
      }
      group.push({ kind: "context", id: context, component_id: context });
      for (const id of recommendations) group.push({ kind: "recommendation", id, component_id: id });
    }
    if (hold !== undefined) { retained.push({ observation_id: observation, reason: hold }); continue; }
    for (const item of group) add(item.kind, item.id);
  }
  return { cutoff, blocked, retained };
}
