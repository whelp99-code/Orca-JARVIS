import { closeSync, existsSync, openSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import { buildFreshAuthority, type FreshAuthorityBuild } from "./memory-authority-fresh-builder.js";
import { isPersistenceTime, persistenceText } from "./personal-persistence-values.js";

const LOCAL_TIMELINE_SOURCE = "src:pos:v1:task-timeline:local";

export type RetentionProjection = { readonly kind: "observation" | "context" | "recommendation";
  readonly id: string; readonly component_id: string };
export type RetentionRetained = { readonly observation_id: string;
  readonly reason: "context_cites_current_observation" | "notification_addresses_recommendation"
    | "outside_event_names_replacement" };
export type LocalObservationRetentionSelection = {
  readonly cutoff: string;
  readonly blocked: readonly RetentionProjection[];
  readonly retained: readonly RetentionRetained[];
};
export type LocalObservationRetentionApplication = {
  readonly selection: LocalObservationRetentionSelection;
  readonly build: FreshAuthorityBuild;
};

/** The floor is the observation expiry window itself; the ceiling is 365 days. */
export const LOCAL_RETENTION_MIN_RETAIN_MS = 300_000;
export const LOCAL_RETENTION_MAX_RETAIN_MS = 31_536_000_000;

export type LocalObservationRetentionConfig = {
  readonly schema_version: 1;
  readonly retain_ms: number;
};

/**
 * Parses the explicit configuration that chooses a cutoff. The record is closed: a different
 * schema version, a missing or extra key, a non-integer window, or one outside
 * [LOCAL_RETENTION_MIN_RETAIN_MS, LOCAL_RETENTION_MAX_RETAIN_MS] is refused rather than
 * defaulted, so no cutoff is ever inferred for a caller that did not state one.
 */
export function parseLocalObservationRetentionConfig(value: unknown): LocalObservationRetentionConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new JarvisError("LOCAL_RETENTION_CONFIG_INVALID");
  }
  const entries = Object.entries(value);
  const record: Record<string, unknown> = Object.fromEntries(entries);
  const retain = record["retain_ms"];
  if (entries.length !== 2 || record["schema_version"] !== 1 || typeof retain !== "number"
    || !Number.isSafeInteger(retain) || retain < LOCAL_RETENTION_MIN_RETAIN_MS
    || retain > LOCAL_RETENTION_MAX_RETAIN_MS) {
    throw new JarvisError("LOCAL_RETENTION_CONFIG_INVALID");
  }
  return { schema_version: 1, retain_ms: retain };
}

/**
 * Derives the instant a configured window cuts at. The window is measured back from the caller's
 * clock, so the selection stays the inclusive `expires_at<=cutoff` rule the selector already
 * documents; the derivation itself reads nothing and decides nothing about removal.
 */
export function resolveLocalObservationRetentionCutoff(
  config: LocalObservationRetentionConfig, now: Date,
): string {
  const at = new Date(now.getTime() - config.retain_ms);
  if (Number.isNaN(at.getTime())) throw new JarvisError("LOCAL_RETENTION_CONFIG_INVALID");
  const cutoff = at.toISOString();
  if (!isPersistenceTime(cutoff)) throw new JarvisError("LOCAL_RETENTION_CONFIG_INVALID");
  return cutoff;
}

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
  // migrations/034 lets an action event name another recommendation as its replacement, and the
  // rebuild filters those rows by their own recommendation, not by the target. Removing a named
  // target while its naming event survives would dangle that key and the rebuild would refuse.
  const namingEvents = database.prepare(
    `SELECT DISTINCT recommendation_id FROM personal_recommendation_action_events
     WHERE replacement_recommendation_id=? ORDER BY recommendation_id`);

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
      const grouped = new Set(recommendations);
      if (recommendations.some(id => namingEvents.pluck().all(id).map(persistenceText)
        .some(naming => !grouped.has(naming)))) {
        hold = "outside_event_names_replacement"; break;
      }
      group.push({ kind: "context", id: context, component_id: context });
      for (const id of recommendations) group.push({ kind: "recommendation", id, component_id: id });
    }
    if (hold !== undefined) { retained.push({ observation_id: observation, reason: hold }); continue; }
    for (const item of group) add(item.kind, item.id);
  }
  return { cutoff, blocked, retained };
}

const DESTINATION_SIDECARS = ["-wal", "-shm", "-journal"] as const;

/**
 * Takes exclusive ownership of the destination name before anything writes through it.
 *
 * String inequality is not file inequality: `/dir/./authority.sqlite`, a relative spelling and a
 * symlink all name the source, and the rebuild adapter removes its destination. The claim resolves
 * the real path, refuses the source's own file, refuses a name whose SQLite sidecars already exist,
 * and then creates the file with O_EXCL so a second caller racing for the same name loses instead
 * of sharing it. Nothing that existed before this call is ever removed.
 */
function claimRetentionDestination(source: AuthorityDb, freshPath: string): string {
  if (typeof freshPath !== "string" || freshPath.trim().length === 0) {
    throw new JarvisError("LOCAL_RETENTION_DESTINATION_INVALID");
  }
  const absolute = resolve(freshPath);
  let destination: string;
  let sourcePath: string;
  try {
    destination = join(realpathSync(dirname(absolute)), basename(absolute));
    sourcePath = realpathSync(source.filename);
  } catch {
    throw new JarvisError("LOCAL_RETENTION_DESTINATION_INVALID");
  }
  if (destination === sourcePath
    || DESTINATION_SIDECARS.some(suffix => existsSync(`${destination}${suffix}`))) {
    throw new JarvisError("LOCAL_RETENTION_DESTINATION_INVALID");
  }
  try {
    closeSync(openSync(destination, "wx", 0o600));
  } catch {
    throw new JarvisError("LOCAL_RETENTION_DESTINATION_INVALID");
  }
  return destination;
}

/** Removes only the file this call created, plus the sidecars the build put beside it. */
function releaseRetentionDestination(destination: string): void {
  for (const suffix of DESTINATION_SIDECARS) rmSync(`${destination}${suffix}`, { force: true });
  rmSync(destination, { force: true });
}

/**
 * Applies a cutoff by rebuilding the authority into a destination this call owns exclusively.
 *
 * The source is neither swapped nor deleted, and its logical rows are unchanged; the rebuild
 * adapter does checkpoint the source's write-ahead log, so the source file's bytes can change
 * while `total_changes()` stays equal. The rebuild adapter remains the only sanctioned deletion
 * path for this immutable lineage, and a failed build takes only this call's own destination
 * with it.
 */
export async function applyLocalObservationRetention(
  source: AuthorityDb, cutoffValue: unknown, freshPath: string,
): Promise<LocalObservationRetentionApplication> {
  const selection = selectLocalObservationRetention(source.db, cutoffValue);
  const destination = claimRetentionDestination(source, freshPath);
  try {
    const build = await buildFreshAuthority(source, destination, {
      blocked_projections: selection.blocked, sensitive_material: [], destination: "claimed",
    });
    return { selection, build };
  } catch (error) {
    releaseRetentionDestination(destination);
    throw error;
  }
}
