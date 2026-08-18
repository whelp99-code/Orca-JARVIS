import { randomUUID } from "node:crypto";
import type { AuthorityDb } from "../db.js";
import { JarvisError } from "../db.js";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";

export const DEFAULT_RECONCILE_TOPICS = ["overview", "tasks", "agents", "approvals"] as const;

const DATA_VERSION_INTERVAL_MS = 1_000;

type SseSink = {
  write(frame: string): void;
  close(): void;
};

type ReconcileEventType = "snapshot" | "reconcile";

export class ReconcileHub {
  private readonly instanceId = randomUUID();
  /** Client set and sequence exist to fan out live frames; mutation is the purpose. */
  private sequence = 0;
  private readonly clients = new Set<SseSink>();

  connect(sink: SseSink): () => void {
    sink.write(this.frame("snapshot", DEFAULT_RECONCILE_TOPICS));
    this.clients.add(sink);
    return () => {
      this.clients.delete(sink);
    };
  }

  publish(topics: readonly string[]): void {
    const frame = this.frame("reconcile", topics);
    for (const sink of this.clients) sink.write(frame);
  }

  close(): void {
    const sinks = [...this.clients];
    this.clients.clear();
    for (const sink of sinks) sink.close();
  }

  private frame(type: ReconcileEventType, topics: readonly string[]): string {
    this.sequence += 1;
    const revision = `${this.instanceId}:${this.sequence}`;
    const payload = {
      schema_version: DASHBOARD_SCHEMA_VERSION,
      type,
      revision,
      topics: [...topics],
      occurred_at: new Date().toISOString(),
    };
    return `id: ${revision}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  }
}

export class DataVersionObserver {
  private lastVersion: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: AuthorityDb,
    private readonly onChange: (topics: readonly string[]) => void,
  ) {
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
    this.timer = setInterval(() => {
      this.check();
    }, intervalMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function createDashboardEvents(db: AuthorityDb): {
  readonly hub: ReconcileHub;
  close(): void;
} {
  const hub = new ReconcileHub();
  const observer = new DataVersionObserver(db, (topics) => {
    hub.publish(topics);
  });
  observer.start(DATA_VERSION_INTERVAL_MS);
  return {
    hub,
    close(): void {
      observer.close();
      hub.close();
    },
  };
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
