import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request, type Dispatcher } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { MEMORY_TOPICS } from "../../src/dashboard/memory-contracts.js";
import { PERSONAL_EVENT_TOPICS } from "../../src/dashboard/personal-contracts.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { tempDb } from "../helpers.js";

const SNAPSHOT_TOPICS = ["overview", "tasks", "agents", "approvals",
  ...new Set(Object.values(PERSONAL_EVENT_TOPICS).flat()), ...MEMORY_TOPICS] as const;
const PUBLISH_TOPICS = ["overview", "tasks"] as const;
const SSE_TIMEOUT_MS = 2_000;

const temporaryDirectories = new Set<string>();

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function track(directory: string): string {
  temporaryDirectories.add(directory);
  return directory;
}

async function migratedDb(): Promise<AuthorityDb> {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  track(dirname(db.filename));
  return db;
}

function startServer(db: AuthorityDb): DashboardServer {
  const root = track(mkdtempSync(join(tmpdir(), "jarvis-dashboard-sse-")));
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
  return createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0 });
}

function originOf(server: DashboardServer): string {
  if (server.address.family !== "IPv4") throw new Error("dashboard server must bind loopback IPv4 only");
  return `http://${server.address.host}:${server.address.port}`;
}

async function settleBody(body: Dispatcher.ResponseData["body"]): Promise<void> {
  try {
    await body.dump();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return;
    throw error;
  }
}

function header(headers: Dispatcher.ResponseData["headers"], name: string): string {
  const value = Array.isArray(headers) ? undefined : headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object");
  return Object.fromEntries(Object.entries(value));
}

function fingerprint(db: AuthorityDb): string {
  return JSON.stringify(db.db.prepare(`SELECT
    (SELECT COUNT(*) FROM control_command_requests) AS requests,
    (SELECT COUNT(*) FROM control_command_receipts) AS receipts,
    (SELECT COUNT(*) FROM control_command_redemptions) AS redemptions,
    (SELECT COUNT(*) FROM control_command_effects) AS effects,
    (SELECT COUNT(*) FROM workflow_runs) AS runs
  `).get());
}

type SseEvent = {
  readonly id: string;
  readonly event: string;
  readonly data: string;
};

function takeSseFrames(buffer: string): { readonly events: SseEvent[]; readonly rest: string } {
  const events: SseEvent[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    if (part.startsWith(":") || part.trim() === "") continue;
    let id = "";
    let eventName = "message";
    const data: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length > 0) events.push({ id, event: eventName, data: data.join("\n") });
  }
  return { events, rest };
}

function timeoutGuard(): { readonly signal: AbortSignal; cancel(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SSE_TIMEOUT_MS);
  timer.unref();
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    },
  };
}

function openSse(body: AsyncIterable<Uint8Array>, signal: AbortSignal): {
  readUntil(enough: (events: readonly SseEvent[]) => boolean): Promise<readonly SseEvent[]>;
} {
  const iterator = body[Symbol.asyncIterator]();
  const events: SseEvent[] = [];
  let buffer = "";
  return {
    async readUntil(enough) {
      if (enough(events)) return events;
      while (!signal.aborted) {
        const next = await iterator.next();
        if (next.done) return events;
        buffer += Buffer.from(next.value).toString("utf8");
        const parsed = takeSseFrames(buffer);
        buffer = parsed.rest;
        events.push(...parsed.events);
        if (enough(events)) return events;
      }
      throw new Error("sse wait aborted");
    },
  };
}

function publish(server: DashboardServer, topics: readonly string[]): void {
  const method = Reflect.get(server, "publish");
  if (typeof method !== "function") throw new Error("dashboard publish seam is missing");
  method.call(server, topics);
}

function eventData(event: SseEvent): Record<string, unknown> {
  return asRecord(parseJson(event.data));
}

function assertOpaque(event: SseEvent, type: "snapshot" | "reconcile"): void {
  expect(event.event).toBe(type);
  expect(event.id.includes(":")).toBe(true);
  const data = eventData(event);
  expect(data.schema_version).toBe(1);
  expect(data.type).toBe(type);
  expect(typeof data.revision).toBe("string");
  expect(String(data.revision).length).toBeGreaterThan(0);
  expect(Array.isArray(data.topics)).toBe(true);
  expect(Object.keys(data).sort()).toEqual(["occurred_at", "revision", "schema_version", "topics", "type"]);
}

function hasMutationInstruction(event: SseEvent): boolean {
  const data = eventData(event);
  return "action" in data || "receipt" in data || "command" in data || "signature" in data;
}

describe("dashboard SSE reconciliation", () => {
  it("opens /api/v1/events with exact headers and an initial snapshot", async () => {
    const db = await migratedDb();
    const server = startServer(db);
    const before = fingerprint(db);
    const guard = timeoutGuard();
    const response = await request(`${originOf(server)}/api/v1/events`, { signal: guard.signal });
    try {
      expect(response.statusCode).toBe(200);
      expect(header(response.headers, "content-type")).toMatch(/^text\/event-stream\b/);
      expect(header(response.headers, "cache-control")).toBe("no-cache, no-transform");
      expect(header(response.headers, "connection")).toBe("keep-alive");
      expect(header(response.headers, "x-accel-buffering")).toBe("no");
      expect(header(response.headers, "x-request-id")).toBeTruthy();
      const events = await openSse(response.body, guard.signal).readUntil((items) => items.some((item) => item.event === "snapshot"));
      const snapshot = events.find((item) => item.event === "snapshot");
      if (snapshot === undefined) throw new Error("missing snapshot");
      assertOpaque(snapshot, "snapshot");
      expect(eventData(snapshot).topics).toEqual([...SNAPSHOT_TOPICS]);
      expect(events.some(hasMutationInstruction)).toBe(false);
      expect(fingerprint(db)).toBe(before);
    } finally {
      guard.cancel();
      await settleBody(response.body);
      server.close();
      db.close();
    }
  });

  it("emits one reconcile after subscribe-then-publish and does not mutate authority", async () => {
    const db = await migratedDb();
    const server = startServer(db);
    const before = fingerprint(db);
    const guard = timeoutGuard();
    const response = await request(`${originOf(server)}/api/v1/events`, { signal: guard.signal });
    try {
      expect(response.statusCode).toBe(200);
      const stream = openSse(response.body, guard.signal);
      const opened = await stream.readUntil((items) => items.some((item) => item.event === "snapshot"));
      expect(opened.some((item) => item.event === "snapshot")).toBe(true);
      publish(server, PUBLISH_TOPICS);
      const events = await stream.readUntil((items) => items.some((item) => item.event === "reconcile"));
      const reconciles = events.filter((item) => item.event === "reconcile");
      expect(reconciles).toHaveLength(1);
      const reconcile = reconciles[0];
      if (reconcile === undefined) throw new Error("missing reconcile");
      assertOpaque(reconcile, "reconcile");
      const topics = eventData(reconcile).topics;
      expect(Array.isArray(topics) ? topics : []).toEqual(expect.arrayContaining([...PUBLISH_TOPICS]));
      expect(hasMutationInstruction(reconcile)).toBe(false);
      expect(fingerprint(db)).toBe(before);
    } finally {
      guard.cancel();
      await settleBody(response.body);
      server.close();
      db.close();
    }
  });

  it("reconnects with a snapshot and does not replay mutation instructions", async () => {
    const db = await migratedDb();
    const server = startServer(db);
    const firstGuard = timeoutGuard();
    const first = await request(`${originOf(server)}/api/v1/events`, { signal: firstGuard.signal });
    try {
      expect(first.statusCode).toBe(200);
      const stream = openSse(first.body, firstGuard.signal);
      await stream.readUntil((items) => items.some((item) => item.event === "snapshot"));
      publish(server, PUBLISH_TOPICS);
      await stream.readUntil((items) => items.some((item) => item.event === "reconcile"));
    } finally {
      firstGuard.cancel();
      await settleBody(first.body);
    }
    const secondGuard = timeoutGuard();
    const second = await request(`${originOf(server)}/api/v1/events`, { signal: secondGuard.signal });
    try {
      expect(second.statusCode).toBe(200);
      const events = await openSse(second.body, secondGuard.signal).readUntil((items) => items.some((item) => item.event === "snapshot"));
      expect(events[0]?.event).toBe("snapshot");
      if (events[0] !== undefined) assertOpaque(events[0], "snapshot");
      expect(events.some((item) => item.event === "reconcile")).toBe(false);
      expect(events.some(hasMutationInstruction)).toBe(false);
    } finally {
      secondGuard.cancel();
      await settleBody(second.body);
      server.close();
      db.close();
    }
  });
});
