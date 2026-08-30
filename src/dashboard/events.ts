import { randomUUID } from "node:crypto";
import type { AuthorityDb } from "../db.js";
import { JarvisError } from "../db.js";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";
import { PERSONAL_EVENT_TOPICS, type PersonalEventKind } from "./personal-contracts.js";

export const DEFAULT_RECONCILE_TOPICS = ["overview", "tasks", "agents", "approvals"] as const;

const DATA_VERSION_INTERVAL_MS = 1_000;
const REPLAY_LIMIT = 128;

type SseSink = { write(frame: string): void; close(): void };
type ReconcileEventType = "snapshot" | "reconcile";
type StoredFrame = { readonly id: string; readonly frame: string };

export class ReconcileHub {
  private readonly instanceId = randomUUID();
  /** Client and replay collections are mutable fan-out state. */
  private sequence = 0;
  private readonly clients = new Set<SseSink>();
  private readonly replay: StoredFrame[] = [];

  connect(sink: SseSink, lastEventId?: string): () => void {
    if (lastEventId === undefined || lastEventId.length === 0) {
      sink.write(this.frame("snapshot", DEFAULT_RECONCILE_TOPICS).frame);
    } else {
      this.resume(sink, lastEventId);
    }
    this.clients.add(sink);
    return () => { this.clients.delete(sink); };
  }

  publish(topics: readonly string[]): void {
    const stored = this.frame("reconcile", uniqueTopics(topics));
    this.replay.push(stored);
    if (this.replay.length > REPLAY_LIMIT) this.replay.shift();
    for (const sink of this.clients) sink.write(stored.frame);
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
      if (index === this.replay.length - 1) {
        sink.write(this.frame("snapshot", [...DEFAULT_RECONCILE_TOPICS, ...allPersonalTopics()]).frame);
      }
      return;
    }
    sink.write(this.frame("snapshot", [...DEFAULT_RECONCILE_TOPICS, ...allPersonalTopics()]).frame);
  }

  private frame(type: ReconcileEventType, topics: readonly string[]): StoredFrame {
    this.sequence += 1;
    const revision = `${this.instanceId}:${this.sequence}`;
    const payload = { schema_version: DASHBOARD_SCHEMA_VERSION, type, revision, topics: [...topics], occurred_at: new Date().toISOString() };
    return { id: revision, frame: `id: ${revision}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n` };
  }
}

export class DataVersionObserver {
  private lastVersion: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly db: AuthorityDb, private readonly onChange: (topics: readonly string[]) => void) {
    this.lastVersion = readDataVersion(db);
  }

  check(): boolean {
    const current = readDataVersion(this.db);
    if (current === this.lastVersion) return false;
    this.lastVersion = current;
    this.onChange(DEFAULT_RECONCILE_TOPICS);
    return true;
  }

  start(intervalMs: number): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => { this.check(); }, intervalMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function createDashboardEvents(db: AuthorityDb): { readonly hub: ReconcileHub; close(): void } {
  const hub = new ReconcileHub();
  const observer = new DataVersionObserver(db, (topics) => { hub.publish(topics); });
  observer.start(DATA_VERSION_INTERVAL_MS);
  return { hub, close(): void { observer.close(); hub.close(); } };
}

export function topicsForPersonalEvent(kind: PersonalEventKind): readonly string[] {
  return PERSONAL_EVENT_TOPICS[kind];
}

function uniqueTopics(topics: readonly string[]): readonly string[] {
  return [...new Set(topics)];
}

function allPersonalTopics(): readonly string[] {
  return uniqueTopics(Object.values(PERSONAL_EVENT_TOPICS).flat());
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
