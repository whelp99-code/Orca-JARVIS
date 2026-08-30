import type { CapabilityProbe } from "../capabilities.js";
import { buildCapabilityMatrix } from "../capabilities.js";
import type { AuthorityDb } from "../db.js";
import { Recommendations } from "../recommendations.js";
import type { PersonalCursorCodec } from "./personal-cursor.js";
import type { PersonalPage, ResourceState } from "./personal-contracts.js";
import { dbRows, nullableText, readOnlySnapshot, readOnlySnapshotAsync, text } from "./personal-db.js";
import { personalPage } from "./personal-page.js";
import { assertSafeIdentifier } from "./personal-privacy.js";

type PageRequest = { readonly limit: number; readonly cursor: string | null; readonly now: Date; readonly codec: PersonalCursorCodec };

export function dailyRunHistory(db: AuthorityDb, request: PageRequest): PersonalPage<Readonly<Record<string, unknown>>> {
  return readOnlySnapshot(db, () => {
    const rows = dbRows(db.db.prepare(
      `SELECT run_id,loop_date,phase,state,result_digest,failure_code,created_at,updated_at,expires_at
       FROM daily_loop_runs WHERE record_version=1 ORDER BY updated_at DESC,run_id DESC`,
    ).all());
    return personalPage({ resource: "daily-runs", values: rows.map((row) => ({
      item: { run_id: safeText(row, "run_id"), loop_date: text(row, "loop_date"), phase: nullableText(row, "phase"),
        state: text(row, "state"), result_digest: nullableText(row, "result_digest"), failure_code: nullableText(row, "failure_code"),
        created_at: text(row, "created_at"), updated_at: text(row, "updated_at"), expires_at: text(row, "expires_at"),
        deep_link: `/daily-runs/${encodeURIComponent(safeText(row, "run_id"))}` },
      key: [text(row, "updated_at"), safeText(row, "run_id")],
    })), limit: request.limit, cursor: request.cursor, now: request.now, codec: request.codec,
    state: rows.length === 0 ? "no_data" : "ready" });
  });
}

export function decisionInbox(db: AuthorityDb, request: PageRequest): PersonalPage<Readonly<Record<string, unknown>>> {
  return readOnlySnapshot(db, () => {
    const projection = new Recommendations(db).project(request.now.toISOString(), 500);
    const values = [...projection.owner_decisions_needed]
      .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at)
        || right.recommendation_id.localeCompare(left.recommendation_id) || right.rank - left.rank)
      .map((action) => ({ item: {
        recommendation_id: action.recommendation_id, context_id: action.context_id, rank: action.rank, title: action.title,
        state: action.state, confidence_class: action.confidence_class, occurred_at: action.occurred_at, expires_at: action.expires_at,
        evidence_digest: action.evidence_digest, identity_digest: action.identity_digest, provenance_digest: action.provenance_digest,
        citations: action.evidence_links, deep_link: `/recommendations/${encodeURIComponent(action.recommendation_id)}?rank=${action.rank}`,
      }, key: [action.occurred_at, `${action.recommendation_id}:${String(action.rank).padStart(2, "0")}`] as const }));
    return personalPage({ resource: "decision-inbox", values, limit: request.limit, cursor: request.cursor,
      now: request.now, codec: request.codec, state: values.length === 0 ? "no_data" : "ready" });
  });
}

export function notificationIntentStates(db: AuthorityDb, request: PageRequest): PersonalPage<Readonly<Record<string, unknown>>> {
  return readOnlySnapshot(db, () => {
    const rows = dbRows(db.db.prepare(
      `SELECT intent_id,correlation_id,urgency,channel,redacted_preview,deep_link,state,expires_at,created_at,updated_at
       FROM notification_intents ORDER BY updated_at DESC,intent_id DESC`,
    ).all());
    return personalPage({ resource: "notification-intents", values: rows.map((row) => ({ item: {
      intent_id: safeText(row, "intent_id"), correlation_id: safeText(row, "correlation_id"), urgency: text(row, "urgency"),
      channel: text(row, "channel"), preview: text(row, "redacted_preview"), deep_link: text(row, "deep_link"),
      state: text(row, "state"), expires_at: text(row, "expires_at"), created_at: text(row, "created_at"),
      updated_at: text(row, "updated_at"),
    }, key: [text(row, "updated_at"), safeText(row, "intent_id")] })), limit: request.limit, cursor: request.cursor,
    now: request.now, codec: request.codec, state: rows.length === 0 ? "no_data" : "ready" });
  });
}

export async function sourceHealth(
  db: AuthorityDb,
  request: PageRequest,
  probe: CapabilityProbe | undefined,
): Promise<PersonalPage<Readonly<Record<string, unknown>>>> {
  return readOnlySnapshotAsync(db, async () => {
    const sources = dbRows(db.db.prepare(
      `SELECT source_id,freshness_state,fresh_until,observed_at,created_at FROM (
         SELECT source_id,freshness_state,fresh_until,observed_at,created_at,
                row_number() OVER (PARTITION BY source_id ORDER BY observed_at DESC,observation_id DESC) AS position
         FROM personal_observations) WHERE position=1 ORDER BY observed_at DESC,source_id DESC`,
    ).all()).map((row): { readonly item: Readonly<Record<string, unknown>>; readonly key: readonly [string, string] } => ({
      item: { kind: "source", source_id: safeText(row, "source_id"), state: sourceState(row, request.now),
        observed_at: text(row, "observed_at"), fresh_until: text(row, "fresh_until"), checked_at: text(row, "created_at") },
      key: [text(row, "observed_at"), `source:${safeText(row, "source_id")}`],
    }));
    const unavailableCapabilities = ["codex", "claude", "orca_read", "gjc", "live_resume"].map(
      (id): { readonly item: Readonly<Record<string, unknown>>; readonly key: readonly [string, string] } => ({
        item: { kind: "capability", capability_id: id, state: "offline", reason: "probe_unavailable", checked_at: request.now.toISOString() },
        key: [request.now.toISOString(), `capability:${id}`],
      }),
    );
    const capabilities = probe === undefined ? unavailableCapabilities : (await buildCapabilityMatrix(db, probe, request.now)).capabilities.map(
      (capability): { readonly item: Readonly<Record<string, unknown>>; readonly key: readonly [string, string] } => ({
        item: { kind: "capability", capability_id: capability.id,
          state: capability.stages.authorized.ok ? "ready" : capability.stages.installed.ok ? "degraded" : "offline",
          stages: capability.stages, checked_at: request.now.toISOString() },
        key: [request.now.toISOString(), `capability:${capability.id}`],
      }),
    );
    const values = [...sources, ...capabilities].sort((left, right) => right.key[0].localeCompare(left.key[0])
      || right.key[1].localeCompare(left.key[1]));
    return personalPage({ resource: "source-health", values, limit: request.limit, cursor: request.cursor, now: request.now,
      codec: request.codec, state: healthState(values.map((value) => String(value.item.state))) });
  });
}

function safeText(row: Readonly<Record<string, unknown>>, key: string): string {
  return assertSafeIdentifier(text(row, key));
}

function sourceState(row: Readonly<Record<string, unknown>>, now: Date): string {
  const persisted = text(row, "freshness_state");
  return persisted === "fresh" && now.toISOString() >= text(row, "fresh_until") ? "stale" : persisted;
}

function healthState(states: readonly string[]): ResourceState {
  if (states.length === 0) return "no_data";
  if (states.every((state) => state === "offline")) return "offline";
  return states.every((state) => state === "ready" || state === "fresh") ? "ready" : "degraded";
}
