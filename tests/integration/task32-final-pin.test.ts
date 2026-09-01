import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import type { SecondBrainReadAdapter, SecondBrainReadOutcome } from "../../src/second-brain-adapter-types.js";
import { tempDb } from "../helpers.js";

const roots: string[] = [];
const open: DashboardServer[] = [];
afterEach(() => {
  for (const server of open.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Minimal read adapter: the profile is the only production seam under test here. */
function adapter(profile: "schema3-read-only" | "schema4"): SecondBrainReadAdapter {
  const empty = async (): Promise<SecondBrainReadOutcome> => ({ kind: "no_data",
    checked_at: "2026-09-01T00:00:00.000Z", fresh_until: "2026-09-01T00:01:00.000Z" });
  return { contract_profile: profile, search: empty, readPage: empty, recentChanges: empty,
    openConflicts: empty };
}

async function serve(injected: SecondBrainReadAdapter | undefined): Promise<DashboardServer> {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  const root = mkdtempSync(join(tmpdir(), "task32-final-pin-"));
  roots.push(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>");
  const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0,
    memoryAdapter: injected, memoryProjectionKey: randomBytes(32),
    memoryEffectSpoolRoot: root, clock: () => new Date("2026-09-01T00:00:00.000Z") });
  open.push(server);
  return server;
}

async function status(server: DashboardServer): Promise<Record<string, unknown>> {
  const base = `http://${server.address.host}:${String(server.address.port)}`;
  const session = await request(`${base}/api/v1/session`);
  const parsed: unknown = JSON.parse(await session.body.text());
  const token = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "csrf_token") : undefined;
  if (typeof token !== "string") throw new TypeError("session token required");
  const response = await request(`${base}/api/v1/memory/status`, { headers: { "X-JARVIS-CSRF": token } });
  const body: unknown = JSON.parse(await response.body.text());
  if (typeof body !== "object" || body === null) throw new TypeError("status object required");
  return Object.fromEntries(Object.entries(body));
}

describe("Task 32 production Memory wiring", () => {
  it("reaches a mutation-enabled ready surface when a schema-4 adapter is injected", async () => {
    // Given a dashboard constructed with the production Memory dependencies
    const server = await serve(adapter("schema4"));
    // When the owner reads Memory status over real HTTP
    const body = await status(server);
    // Then the surface is ready on contract 4 with mutations enabled
    expect(body["state"]).toBe("ready");
    expect(body["contract_schema"]).toBe(4);
    expect(body["mutations_enabled"]).toBe(true);
  });

  it("keeps a schema-3 provider read-only rather than enabling mutations", async () => {
    // Given a dashboard wired to an exact schema-3 read-only provider
    const server = await serve(adapter("schema3-read-only"));
    // When the owner reads Memory status over real HTTP
    const body = await status(server);
    // Then reads are available but no mutation surface is offered
    expect(body["state"]).toBe("ready");
    expect(body["contract_schema"]).toBe(3);
    expect(body["mutations_enabled"]).toBe(false);
  });

  it("reports unavailable when no Memory adapter is injected", async () => {
    // Given a dashboard started without Memory dependencies
    const server = await serve(undefined);
    // When the owner reads Memory status over real HTTP
    const body = await status(server);
    // Then the surface is explicitly unavailable rather than pretending readiness
    expect(body["state"]).toBe("unavailable");
    expect(body["contract_schema"]).toBeNull();
    expect(body["mutations_enabled"]).toBe(false);
  });
});
