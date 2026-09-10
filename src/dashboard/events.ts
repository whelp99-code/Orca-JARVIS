import { SSE_FRAME_MAX_BYTES } from "./sse-bounded-sink.js";
import { createHash, randomUUID } from "node:crypto";
import type { AuthorityDb } from "../db.js";
import { canonicalize } from "../canonical.js";
import { JarvisError } from "../db.js";
import { subscribeMemorySuppression } from "../memory-suppression-events.js";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";
import { MEMORY_TOPICS } from "./memory-contracts.js";
import { PERSONAL_EVENT_TOPICS, type PersonalEventKind } from "./personal-contracts.js";

export const DEFAULT_RECONCILE_TOPICS = ["overview", "tasks", "agents", "approvals"] as const;

const DATA_VERSION_INTERVAL_MS = 1_000;
const REPLAY_LIMIT = 128;
export const SSE_MAX_CLIENTS = 128;
const NOTIFICATION_FINGERPRINT_LIMIT = 1_024;

type SseSink = { write(frame: string): void; close(): void };
type ReconcileEventType = "snapshot" | "reconcile";
type StoredFrame = { readonly id: string; readonly frame: string };

export class ReconcileHub {
  private readonly instanceId = randomUUID();
  /** Client and replay collections are mutable fan-out state. */
  private sequence = 0;
  private readonly clients = new Set<SseSink>();
  private readonly replay: StoredFrame[] = [];

  get hasCapacity(): boolean { return this.clients.size < SSE_MAX_CLIENTS; }

  connect(sink: SseSink, lastEventId?: string): () => void {
    if (!this.clients.has(sink) && !this.hasCapacity) throw new JarvisError("SSE_CAPACITY_EXCEEDED");
    this.clients.add(sink);
    try {
      if (lastEventId === undefined || lastEventId.length === 0) {
        sink.write(this.frame("snapshot", snapshotTopics()).frame);
      } else {
        this.resume(sink, lastEventId);
      }
    } catch (error) {
      this.clients.delete(sink);
      throw error;
    }
    return () => { this.clients.delete(sink); };
  }

  publish(topics: readonly string[]): void {
    const stored = this.frame("reconcile", topics);
    this.replay.push(stored);
    if (this.replay.length > REPLAY_LIMIT) this.replay.shift();
    for (const sink of this.clients) {
      try { sink.write(stored.frame); }
      catch {
        this.clients.delete(sink);
        try { sink.close(); } catch { /* A failed connection cannot interrupt the remaining subscribers. */ }
      }
    }
  }

  resync(sink: SseSink): void {
    if (this.clients.has(sink)) sink.write(this.frame("snapshot", snapshotTopics()).frame);
  }

  publishPersonal(kind: PersonalEventKind): void {
    this.publish(PERSONAL_EVENT_TOPICS[kind]);
  }

  close(): void {
    const sinks = [...this.clients];
    this.clients.clear();
    this.replay.splice(0);
    for (const sink of sinks) sink.close();
  }

  private resume(sink: SseSink, lastEventId: string): void {
    const index = this.replay.findIndex((item) => item.id === lastEventId);
    if (index >= 0) {
      for (const item of this.replay.slice(index + 1)) sink.write(item.frame);
      if (index === this.replay.length - 1) sink.write(this.frame("snapshot", snapshotTopics()).frame);
      return;
    }
    sink.write(this.frame("snapshot", snapshotTopics()).frame);
  }

  private frame(type: ReconcileEventType, topics: readonly string[]): StoredFrame {
    this.sequence += 1;
    const revision = `${this.instanceId}:${this.sequence}`;
    const limited = boundedTopics(topics);
    const payload = { schema_version: DASHBOARD_SCHEMA_VERSION, type: limited === null ? "snapshot" : type,
      revision, topics: limited ?? snapshotTopics(), occurred_at: new Date().toISOString() };
    const encode = () => `id: ${revision}\nevent: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
    let frame = encode();
    if (Buffer.byteLength(frame, "utf8") > SSE_FRAME_MAX_BYTES) {
      payload.type = "snapshot";
      payload.topics = snapshotTopics();
      frame = encode();
    }
    return { id: revision, frame };
  }
}

export class DataVersionObserver {
  private lastVersion: number;
  private notificationFingerprint: string;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly db: AuthorityDb, private readonly onChange: (topics: readonly string[]) => void) {
    this.lastVersion = readDataVersion(db);
    this.notificationFingerprint = readNotificationFingerprint(db, this.lastVersion);
  }

  check(): boolean {
    const current = readDataVersion(this.db);
    if (current === this.lastVersion) return false;
    this.lastVersion = current;
    const fingerprint = readNotificationFingerprint(this.db, current);
    const changed = fingerprint !== this.notificationFingerprint;
    this.notificationFingerprint = fingerprint;
    this.onChange(changed ? PERSONAL_EVENT_TOPICS.notification : DEFAULT_RECONCILE_TOPICS);
    return true;
  }

  start(intervalMs: number, onTick?: () => void): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => { this.check(); onTick?.(); }, intervalMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function createDashboardEvents(db: AuthorityDb, onTick?: () => void): { readonly hub: ReconcileHub; close(): void } {
  const hub = new ReconcileHub();
  const observer = new DataVersionObserver(db, (topics) => { hub.publish(topics); });
  const unsubscribeSuppression = subscribeMemorySuppression(db, () => {
    hub.publish(["memory.privacy.v1", "memory.records.v1", "memory.conflicts.v1", "memory.effects.v1"]);
  });
  observer.start(DATA_VERSION_INTERVAL_MS, onTick);
  return { hub, close(): void { unsubscribeSuppression(); observer.close(); hub.close(); } };
}

export function topicsForPersonalEvent(kind: PersonalEventKind): readonly string[] {
  return PERSONAL_EVENT_TOPICS[kind];
}

function uniqueTopics(topics: readonly string[]): readonly string[] {
  return [...new Set(topics)];
}

function allPersonalTopics(): readonly string[] {
  return uniqueTopics([...Object.values(PERSONAL_EVENT_TOPICS).flat(), ...MEMORY_TOPICS]);
}
function snapshotTopics(): readonly string[] {
  return uniqueTopics([...DEFAULT_RECONCILE_TOPICS, ...allPersonalTopics()]);
}

function readNotificationFingerprint(db: AuthorityDb, dataVersion: number): string {
  const countValue = db.db.prepare("SELECT count(*) AS count FROM notification_intents").get();
  const count = typeof countValue === "object" && countValue !== null ? Reflect.get(countValue, "count") : undefined;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new JarvisError("INTERNAL_ERROR");
  if (count > NOTIFICATION_FINGERPRINT_LIMIT) return `overflow:${dataVersion}`;
  const rows = db.db.prepare("SELECT intent_id,state,updated_at FROM notification_intents ORDER BY intent_id").all();
  return createHash("sha256").update(canonicalize(rows)).digest("hex");
}

function readDataVersion(db: AuthorityDb): number {
  const value = db.db.pragma("data_version", { simple: true });
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    if (Number.isSafeInteger(asNumber)) return asNumber;
  }
  throw new JarvisError("INTERNAL_ERROR");
}

/** Keep payloads within the clients' 32-topic contract and bound the shared replay ring by bytes. */
function boundedTopics(topics: readonly string[]): readonly string[] | null {
  const unique = new Set<string>();
  for (const topic of topics) {
    if (Buffer.byteLength(topic, "utf8") > 256) return null;
    unique.add(topic);
    if (unique.size > 32) return null;
  }
  return [...unique];
}
