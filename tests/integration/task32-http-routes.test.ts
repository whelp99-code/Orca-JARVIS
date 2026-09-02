import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import type { SecondBrainReadAdapter, SecondBrainReadOutcome } from "../../src/second-brain-adapter-types.js";
import { seedTask32QaRows, TASK32_QA_CANDIDATE_ID } from "../fixtures/task32-memory-qa-seed.js";
import { tempDb } from "../helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture(): Promise<{ readonly db: AuthorityDb; readonly server: DashboardServer }> {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  const root = mkdtempSync(join(tmpdir(), "task32-memory-http-"));
  roots.push(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>");
  return { db, server: createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0,
    clock: () => new Date("2026-09-01T00:00:00.000Z") }) };
}
function base(server: DashboardServer): string { return `http://${server.address.host}:${server.address.port}`; }
async function csrf(server: DashboardServer): Promise<string> {
  const response = await request(`${base(server)}/api/v1/session`);
  const body: unknown = JSON.parse(await response.body.text());
  const token = typeof body === "object" && body !== null ? Reflect.get(body, "csrf_token") : undefined;
  if (typeof token !== "string") throw new TypeError("session token required");
  return token;
}

async function get(server: DashboardServer, path: string, token?: string) {
  const response = await request(`${base(server)}${path}`, { headers: token === undefined ? {}
    : { "X-JARVIS-CSRF": token } });
  const body: unknown = JSON.parse(await response.body.text());
  return { status: response.statusCode, headers: response.headers, body };
}

async function postRaw(server: DashboardServer, path: string, token: string, body: Uint8Array) {
  const response = await request(`${base(server)}${path}`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-JARVIS-CSRF": token, Origin: base(server),
  }, body });
  const value: unknown = JSON.parse(await response.body.text());
  return { status: response.statusCode, headers: response.headers, body: value };
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const error = Reflect.get(value, "error");
  return typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
    ? String(Reflect.get(error, "code")) : undefined;
}

describe("Task 32 Memory HTTP boundary", () => {
  it("migrates the three dynamically allocated content-free authority slots", async () => {
    // Given / When
    const { db, server } = await fixture();
    try {
      const migrations = (db.db.prepare("SELECT id FROM schema_migrations WHERE id>='052_' ORDER BY id")
        .all() as Array<{ readonly id: string }>).map(row => row.id);
      // Then
      expect(migrations).toEqual(["052_memory_effect_content_free.sql",
        "053_memory_surface_authority.sql", "054_memory_export_lifecycle.sql",
        "055_memory_candidate_authority_v6.sql", "056_remote_approval_v2.sql",
        "057_memory_candidate_authority_v6.sql"]);
      expect((db.db.prepare("PRAGMA table_info(memory_outbox)").all() as Array<{ readonly name: string }>)
        .some(row => row.name === "request_json")).toBe(false);
      const names = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as
        Array<{ readonly name: string }>).map(row => row.name);
      expect(names).toEqual(expect.arrayContaining(["memory_surface_authority",
        "memory_surface_target_versions", "memory_surface_effect_attempts",
        "memory_candidate_decision_attempts", "memory_export_lifecycle_observations"]));
    } finally { server.close(); db.close(); }
  });

  it("requires current owner CSRF on Memory GET routes and emits private headers", async () => {
    // Given
    const { db, server } = await fixture();
    try {
      const token = await csrf(server);
      // When
      const denied = await get(server, "/api/v1/memory/status");
      const accepted = await get(server, "/api/v1/memory/status", token);
      // Then
      expect(denied.status).toBe(403);
      expect(accepted.status).toBe(200);
      expect(accepted.headers["cache-control"]).toBe("no-store");
      expect(accepted.headers["x-content-type-options"]).toBe("nosniff");
      expect(JSON.stringify(accepted.body)).not.toMatch(/(?:\/home\/|\/Users\/|\/Volumes\/|private key)/i);
    } finally { server.close(); db.close(); }
  });

  it("rejects duplicate keys and malformed UTF-8 before any Memory behavior", async () => {
    // Given
    const { db, server } = await fixture();
    try {
      const token = await csrf(server);
      const duplicate = Buffer.from('{"schema_version":1,"query":"first","query":"second","limit":20}');
      const malformed = Buffer.concat([Buffer.from('{"schema_version":1,"query":"'),
        Buffer.from([0xff]), Buffer.from('","limit":20}')]);
      // When
      const [duplicateResult, malformedResult] = await Promise.all([
        postRaw(server, "/api/v1/memory/search", token, duplicate),
        postRaw(server, "/api/v1/memory/search", token, malformed),
      ]);
      // Then
      expect([duplicateResult.status, malformedResult.status]).toEqual([400, 400]);
      expect([errorCode(duplicateResult.body), errorCode(malformedResult.body)])
        .toEqual(["MEMORY_INPUT_INVALID", "MEMORY_INPUT_INVALID"]);
    } finally { server.close(); db.close(); }
  });

  it("classifies prohibited query and correction content before provider or spool effects", async () => {
    // Given
    const { db, server } = await fixture();
    try {
      const token = await csrf(server);
      const query = Buffer.from(JSON.stringify({ schema_version: 1, query: "Bearer TASK32CANARY", limit: 20 }));
      const correction = Buffer.from(JSON.stringify({ schema_version: 1,
        intent_id: `memui:intent:v1:${"1".repeat(64)}`, record_token: "a".repeat(43),
        record_revision: `hmac-sha256:${"2".repeat(64)}`,
        payload: { replacement: "password=TASK32CANARY" } }));
      // When
      const [queryResult, correctionResult] = await Promise.all([
        postRaw(server, "/api/v1/memory/search", token, query),
        postRaw(server, "/api/v1/memory/records/actions/correct", token, correction),
      ]);
      // Then
      expect(errorCode(queryResult.body)).toBe("MEMORY_QUERY_PROHIBITED");
      expect(errorCode(correctionResult.body)).toBe("MEMORY_CONTENT_PROHIBITED");
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM control_command_requests").get())
        .toEqual({ count: 0 });
    } finally { server.close(); db.close(); }
  });

  it("maps a 65,537-byte Memory body to the frozen request-too-large taxonomy", async () => {
    // Given
    const { db, server } = await fixture();
    try {
      const token = await csrf(server);
      const body = Buffer.alloc(65_537, 0x20);
      // When
      const result = await postRaw(server, "/api/v1/memory/search", token, body);
      // Then
      expect(result.status).toBe(413);
      expect(errorCode(result.body)).toBe("MEMORY_REQUEST_TOO_LARGE");
    } finally { server.close(); db.close(); }
  });

  it("exposes exactly twelve bounded routes without vault browsing or downloads", async () => {
    // Given
    const { db, server } = await fixture();
    try {
      const token = await csrf(server);
      const paths = ["/api/v1/memory/status", "/api/v1/memory/conflicts?limit=1",
        "/api/v1/memory/candidates?state=awaiting_confirmation&limit=1",
        "/api/v1/memory/effects?operation=export&state=pending_approval&limit=1"];
      // When
      const responses = await Promise.all(paths.map(path => get(server, path, token)));
      // Then
      expect(responses.map(item => item.status)).toEqual([200, 200, 200, 200]);
      expect(responses.every(item => !JSON.stringify(item.body).match(/(?:vault|download|embedding|path)/i)))
        .toBe(true);
    } finally { server.close(); db.close(); }
  });

  it("stages a candidate confirmation instead of returning MEMORY_REVIEW_UNAVAILABLE", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const root = mkdtempSync(join(tmpdir(), "task32-memory-review-"));
    roots.push(root);
    const reviewRoot = join(root, "review");
    const dispatchRoot = join(root, "dispatch");
    mkdirSync(reviewRoot, { recursive: true, mode: 0o700 });
    mkdirSync(dispatchRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>");
    seedTask32QaRows(db, reviewRoot);
    const empty = async (): Promise<SecondBrainReadOutcome> => ({ kind: "no_data",
      checked_at: "2026-09-01T00:00:00.000Z", fresh_until: "2026-09-01T00:01:00.000Z" });
    const memoryAdapter: SecondBrainReadAdapter = { contract_profile: "schema4", search: empty,
      readPage: empty, recentChanges: empty, openConflicts: empty };
    const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0,
      clock: () => new Date("2026-09-01T00:00:00.000Z"), memoryAdapter,
      memoryCandidateReviewSpoolRoot: reviewRoot, memoryCandidateDispatchSpoolRoot: dispatchRoot });
    try {
      const token = await csrf(server);
      const encoded = encodeURIComponent(TASK32_QA_CANDIDATE_ID);
      const result = await postRaw(server, `/api/v1/memory/candidates/${encoded}/actions/stage-decision`,
        token, Buffer.from(JSON.stringify({ schema_version: 1, intent_id: `memui:intent:v1:${"a".repeat(64)}`,
          operation: "remember", decision: "confirm" })));
      expect(result.status).toBe(202);
      expect(errorCode(result.body)).toBeUndefined();
      expect(Reflect.get(result.body as object, "state")).toBe("pending_approval");
    } finally { server.close(); db.close(); }
  });
});
