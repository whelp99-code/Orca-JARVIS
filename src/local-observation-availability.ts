import type Database from "better-sqlite3";
import { JarvisError } from "./jarvis-error.js";
import { readCurrentLocalTimelineObservation } from "./local-timeline-observation.js";
import { persistenceText } from "./personal-persistence-values.js";

const LOCAL_TIMELINE_SOURCE = "src:pos:v1:task-timeline:local";

/** Contexts whose admitted local observations no longer match their current source at this clock. */
export function contextsWithUnavailableLocalSource(database: Database.Database, contextIds: readonly string[],
  now: string): ReadonlySet<string> {
  const unavailable = new Set<string>();
  const select = database.prepare(
    `SELECT o.observation_id FROM personal_context_observations o
     JOIN personal_observations p ON p.observation_id=o.observation_id
     WHERE o.context_id=? AND p.source_id=? ORDER BY o.position`,
  );
  const clock = (): Date => new Date(now);
  for (const contextId of contextIds) {
    for (const value of select.pluck().all(contextId, LOCAL_TIMELINE_SOURCE)) {
      try { readCurrentLocalTimelineObservation({ db: database }, persistenceText(value), clock); }
      catch (error) {
        if (!(error instanceof JarvisError)) throw error;
        unavailable.add(contextId);
      }
    }
  }
  return unavailable;
}

/** Recommendations whose cited context carries an unavailable local observation at this clock. */
export function recommendationsWithUnavailableLocalSource(database: Database.Database,
  recommendationIds: readonly string[], now: string): ReadonlySet<string> {
  const select = database.prepare("SELECT context_id FROM personal_recommendations WHERE recommendation_id=?");
  const byContext = new Map<string, string[]>();
  for (const id of new Set(recommendationIds)) {
    const value = select.pluck().get(id);
    if (value === undefined) continue;
    const contextId = persistenceText(value);
    byContext.set(contextId, [...byContext.get(contextId) ?? [], id]);
  }
  const unavailable = contextsWithUnavailableLocalSource(database, [...byContext.keys()], now);
  return new Set([...unavailable].flatMap(contextId => byContext.get(contextId) ?? []));
}
