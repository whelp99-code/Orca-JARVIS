import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { MessengerPersonalConnectorSource } from "../../src/personal-connector-messenger-source.js";
import { migratedTestDatabase } from "../fixtures/migrated-database.js";
import type { AuthorityDb } from "../../src/db.js";

const root = mkdtempSync(join(tmpdir(), "jarvis-messenger-http-"));
const file = join(root, "summary.json");
const now = new Date("2026-10-13T00:00:00.000Z");
const summary = { schema_version: 1, observed_at: now.toISOString(),
  incomplete_count: 2, oldest_incomplete_age_ms: 300_000 };
let db: AuthorityDb;
let server: DashboardServer;
let unconfigured: DashboardServer;
let origin: string;
let csrf: string;
beforeAll(async () => {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("POSIX_REQUIRED");
  writeFileSync(join(root, "index.html"), "<!doctype html><title>test</title>");
  db = await migratedTestDatabase(join(root, "authority.sqlite"));
  server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0, clock: () => now,
    messengerSource: new MessengerPersonalConnectorSource({ snapshot_file: file, producer_uid: uid }) });
  unconfigured = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0, clock: () => now });
  origin = `http://127.0.0.1:${server.address.port}`;
  csrf = (await fetch(origin + "/api/v1/session").then(response => response.json())).csrf_token;
});
beforeEach(() => {
  writeFileSync(file, JSON.stringify(summary), { mode: 0o640 });
  chmodSync(file, 0o640);
});
afterAll(async () => {
  server.close(); unconfigured.close();
  await Promise.all([server.drain(), unconfigured.drain()]);
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const path = "/api/v1/connectors/messenger";
const headers = () => ({ "x-jarvis-csrf": csrf });

describe("protected count-only messenger HTTP", () => {
  it("returns only count age and observation from the configured snapshot", async () => {
    // Given a valid private snapshot, when requested with the local session.
    const response = await fetch(origin + path, { headers: headers() });
    const result = await response.json();
    // Then the actual HTTP boundary exposes no source payload or checkpoint.
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(result).toMatchObject({ connector_id: "messenger", configured: true, state: "ready", freshness: "fresh",
      checkpoint: null, checkpoint_session: { mode: "stateless", handle: null },
      values: { incomplete_count: 2, oldest_incomplete_age_ms: 300_000 } });
    expect(Object.keys(result.values).sort()).toEqual(["incomplete_count", "observed_at", "oldest_incomplete_age_ms"]);
  });
  it("returns no_data only for an explicit complete empty snapshot", async () => {
    // Given a trusted empty export.
    writeFileSync(file, JSON.stringify({ ...summary, incomplete_count: 0, oldest_incomplete_age_ms: null }));
    // When/Then the protected HTTP read distinguishes empty from failure.
    const result = await fetch(origin + path, { headers: headers() }).then(response => response.json());
    expect(result).toMatchObject({ state: "no_data", reason: "current_empty", values: {} });
  });
  it("does not turn an expired producer into zero incomplete messages", async () => {
    // Given a stopped exporter with an expired snapshot.
    writeFileSync(file, JSON.stringify({ ...summary, observed_at: new Date(now.getTime() - 60_001).toISOString() }));
    // When/Then HTTP fails closed without projecting any values.
    const result = await fetch(origin + path, { headers: headers() }).then(response => response.json());
    expect(result).toMatchObject({ configured: true, state: "unavailable", reason: "adapter_failed", values: {} });
  });
  it("rejects missing session foreign origin query overrides and mutations", async () => {
    // Given invalid authority or caller overrides, when those requests are sent.
    const responses = await Promise.all([
      fetch(origin + path), fetch(origin + path, { headers: { ...headers(), origin: "https://foreign.invalid" } }),
      fetch(origin + path + "?user=other", { headers: headers() }),
      fetch(origin + path, { method: "POST", headers: headers() }),
    ]);
    // Then none is accepted as a summary.
    expect(responses.map(response => response.status)).toEqual([403, 403, 400, 403]);
    await Promise.all(responses.map(response => response.arrayBuffer()));
  });
  it("keeps messenger unconfigured when no source was opted in", async () => {
    // Given the server with no messenger source.
    const target = `http://127.0.0.1:${unconfigured.address.port}`;
    const session = await fetch(target + "/api/v1/session").then(response => response.json());
    // When the user asks for its summary.
    const result = await fetch(target + path, { headers: { "x-jarvis-csrf": session.csrf_token } })
      .then(response => response.json());
    // Then configuration is not fabricated.
    expect(result).toMatchObject({ configured: false, state: "unavailable", reason: "not_configured", values: {} });
  });
});
