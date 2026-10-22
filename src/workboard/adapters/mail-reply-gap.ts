import type { WorkEvent } from "../contracts.js";
import { sourceKey, workKey, sessionKey } from "../contracts.js";
import { metadataEvent } from "./session-metadata.js";
import type { WorkboardStore } from "../store.js";

/** Mail Intelligence reply-gap projection. Collectors own this table set; the dashboard stays read-only. */
export const MAIL_REPLY_GAP_SOURCE = { host: "linux", app: "mail", scope: "reply-gap", generation: "v1" } as const;
/** Phone-reachable Mail Intelligence. Override with `JARVIS_MAIL_REPLY_GAP_BASE_URL`. */
export const MAIL_REPLY_GAP_BASE_URL_DEFAULT = "https://jm-omachy.alpines-goldeye.ts.net:8451";

export function resolveMailReplyGapBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.JARVIS_MAIL_REPLY_GAP_BASE_URL?.trim();
  const value = configured && configured.length > 0 ? configured : MAIL_REPLY_GAP_BASE_URL_DEFAULT;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("MAIL_REPLY_GAP_LINK_INVALID"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname.length === 0
    || url.username.length > 0 || url.password.length > 0) throw new Error("MAIL_REPLY_GAP_LINK_INVALID");
  return url.origin;
}

export type ReplyGapItem = { id: string; subject: string; receivedAt: string };
export type ReplyGapSnapshot = { observedAt: string; baseUrl?: string; open: ReplyGapItem[] };
export type ReplyGapResult = { source: string; opened: number; closed: number; openIds: string[] };

const SOURCE_KEY = sourceKey(MAIL_REPLY_GAP_SOURCE);

function messageId(id: string): string {
  if (!/^\d+$/u.test(id)) throw new Error("MAIL_REPLY_GAP_SNAPSHOT_INVALID");
  const numeric = Number(id);
  if (!Number.isSafeInteger(numeric) || numeric < 1) throw new Error("MAIL_REPLY_GAP_SNAPSHOT_INVALID");
  return String(numeric);
}

function summaryOf(subject: string): string {
  const text = subject.replace(/\s+/gu, " ").trim() || "(제목 없음)";
  const clipped = text.length > 80 ? `${text.slice(0, 79)}…` : text;
  return `회신: ${clipped}`;
}

function pinnedBase(baseUrl: string | undefined): string {
  const configured = resolveMailReplyGapBaseUrl();
  const given = new URL(baseUrl ?? configured);
  if (given.origin !== configured) throw new Error("MAIL_REPLY_GAP_LINK_INVALID");
  return configured;
}

function linkFor(baseUrl: string, id: string): string {
  const href = `${baseUrl}/#m=${encodeURIComponent(id)}`;
  if (href.length > 256 || /[\0\r\n]/u.test(href)) throw new Error("MAIL_REPLY_GAP_LINK_INVALID");
  return href;
}

function eventFor(item: ReplyGapItem, snapshot: ReplyGapSnapshot, kind: "open" | "close", baseUrl: string): WorkEvent {
  const taskId = messageId(item.id);
  const when = kind === "open" ? item.receivedAt : snapshot.observedAt;
  return metadataEvent(MAIL_REPLY_GAP_SOURCE, {
    sessionId: `msg:${taskId}`,
    incarnation: "reply-gap",
    eventId: `${kind}:${taskId}:${snapshot.observedAt}`,
    sequence: Date.parse(snapshot.observedAt),
    observedAt: snapshot.observedAt,
    sourceAt: when,
    taskId,
    state: kind === "open" ? "waiting" : "verified",
    summary: kind === "open" ? summaryOf(item.subject) : `회신 완료: ${summaryOf(item.subject).slice(4)}`,
    evidenceRef: linkFor(baseUrl, taskId),
  });
}

function validateSnapshot(snapshot: ReplyGapSnapshot): string {
  if (!Number.isFinite(Date.parse(snapshot.observedAt))) throw new Error("MAIL_REPLY_GAP_OBSERVATION_INVALID");
  let baseUrl: string;
  try { baseUrl = pinnedBase(snapshot.baseUrl); } catch { throw new Error("MAIL_REPLY_GAP_LINK_INVALID"); }
  if (!Array.isArray(snapshot.open)) throw new Error("MAIL_REPLY_GAP_SNAPSHOT_INVALID");
  const ids = new Set<string>();
  for (const item of snapshot.open) {
    if (!item || typeof item.id !== "string" || typeof item.subject !== "string" || !Number.isFinite(Date.parse(item.receivedAt))) {
      throw new Error("MAIL_REPLY_GAP_SNAPSHOT_INVALID");
    }
    const id = messageId(item.id);
    if (ids.has(id)) throw new Error("MAIL_REPLY_GAP_SNAPSHOT_INVALID");
    ids.add(id);
  }
  return baseUrl;
}

const LEGACY_ORIGINS = ["100.87.81.57", "jm-acloud.alpines-goldeye.ts.net"].flatMap(host =>
  ["http", "https"].flatMap(protocol => [3010, 8451].map(port => `${protocol}://${host}:${port}`)));
const KNOWN_ORIGINS = [...LEGACY_ORIGINS, MAIL_REPLY_GAP_BASE_URL_DEFAULT];
function knownOrigin(value: string): string | undefined {
  return KNOWN_ORIGINS.find(origin => value.startsWith(origin) && ["", "/", "?", "#"].includes(value[origin.length] ?? ""));
}

/** Reconcile current links even on replayed observations; original event bytes stay immutable. */
function reconcileEvidenceOrigins(store: WorkboardStore, baseUrl: string): void {
  const rows = store.db.prepare(
    `SELECT w.work_id,w.task_id,w.evidence_ref,r.prior_evidence_ref FROM workboard_works w
     LEFT JOIN workboard_evidence_ref_host_remap_20261016 r USING(work_id)
     WHERE w.source_key=? AND w.evidence_ref IS NOT NULL`,
  ).all(SOURCE_KEY) as Array<{ work_id: string; task_id: string | null; evidence_ref: string; prior_evidence_ref: string | null }>;
  for (const row of rows) {
    let url: URL;
    try { url = new URL(row.evidence_ref); } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.origin === baseUrl) continue;
    const previousOrigin = row.prior_evidence_ref ? knownOrigin(row.prior_evidence_ref) : undefined;
    const suffix = row.evidence_ref.slice(url.origin.length);
    const generated = row.task_id !== null && /^\d+$/u.test(row.task_id)
      && row.evidence_ref === `${url.origin}/#m=${row.task_id}`;
    const retained = previousOrigin !== undefined && row.prior_evidence_ref !== null
      && suffix === row.prior_evidence_ref.slice(previousOrigin.length);
    if (!knownOrigin(row.evidence_ref) && !generated && !retained) continue;
    const next = `${baseUrl}${suffix}`;
    if (next.length > 256 || /[\0\r\n]/u.test(next)) throw new Error("MAIL_REPLY_GAP_LINK_INVALID");
    store.db.prepare(
      `INSERT INTO workboard_evidence_ref_host_remap_20261016(work_id,prior_evidence_ref)
       VALUES(?,?) ON CONFLICT(work_id) DO NOTHING`,
    ).run(row.work_id, row.evidence_ref);
    store.db.prepare("UPDATE workboard_works SET evidence_ref=? WHERE work_id=? AND source_key=?")
      .run(next, row.work_id, SOURCE_KEY);
  }
}

/**
 * Project the current reply-gap set. Open rows become owner-decision tasks.
 * Rows that left the set (replied, handled elsewhere, promotional, deleted, or aged out)
 * are recorded as verified and removed from the current board.
 */
export function projectMailReplyGaps(store: WorkboardStore, snapshot: ReplyGapSnapshot): ReplyGapResult {
  const baseUrl = validateSnapshot(snapshot);
  const openIds = snapshot.open.map(item => item.id);
  const openTokens = new Set(snapshot.open.map(item => messageId(item.id)));
  return store.db.transaction(() => {
    reconcileEvidenceOrigins(store, baseUrl);
    let opened = 0;
    let closed = 0;
    for (const item of snapshot.open) {
      const taskId = messageId(item.id);
      const existing = store.db.prepare(
        "SELECT sequence FROM workboard_works WHERE source_key=? AND task_id=?",
      ).get(SOURCE_KEY, taskId) as { sequence: number } | undefined;
      if (!existing || existing.sequence < Date.parse(snapshot.observedAt)) {
        store.ingest(eventFor(item, snapshot, "open", baseUrl));
        opened += existing ? 0 : 1;
      }
      const session = sessionKey(MAIL_REPLY_GAP_SOURCE, `msg:${taskId}`);
      const workId = workKey(session, taskId);
      store.db.prepare(`INSERT INTO workboard_attention(
        work_id, sequence, last_progress_received_at, attempt_execution, action_delivery,
        wait_kind, wait_reason, wait_started_at, deadline_at, impact, decision_valid)
        VALUES(?, ?, ?, 'waiting', 'none', 'user_decision', '회신 필요', ?, NULL, NULL, 1)
        ON CONFLICT(work_id) DO UPDATE SET
          sequence=excluded.sequence, last_progress_received_at=excluded.last_progress_received_at,
          attempt_execution='waiting', wait_kind='user_decision',
          wait_reason='회신 필요', decision_valid=1`).run(
        workId, Date.parse(snapshot.observedAt), snapshot.observedAt, item.receivedAt,
      );
    }
    const stale = store.db.prepare(
      "SELECT work_id, task_id, summary FROM workboard_works WHERE source_key=?",
    ).all(SOURCE_KEY) as Array<{ work_id: string; task_id: string | null; summary: string }>;
    for (const row of stale) {
      if (row.task_id !== null && openTokens.has(row.task_id)) continue;
      const item: ReplyGapItem = {
        id: row.task_id ?? row.work_id,
        subject: row.summary.replace(/^회신: /u, ""),
        receivedAt: snapshot.observedAt,
      };
      store.ingest(eventFor(item, snapshot, "close", baseUrl));
      store.db.prepare("DELETE FROM workboard_attention WHERE work_id=?").run(row.work_id);
      store.db.prepare("DELETE FROM workboard_works WHERE work_id=?").run(row.work_id);
      closed += 1;
    }
    store.db.prepare(
      "UPDATE workboard_sources SET warning=NULL, last_successful_observation=? WHERE source_key=?",
    ).run(snapshot.observedAt, SOURCE_KEY);
    return { source: SOURCE_KEY, opened, closed, openIds };
  })();
}
