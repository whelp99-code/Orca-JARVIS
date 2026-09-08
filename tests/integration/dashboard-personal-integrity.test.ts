import { todayProjection } from "../../src/dashboard/personal-today.js";
import type { TrustedCloseoutKey } from "../../src/evening-closeout-types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthorityDb,
  DailyLoopStore,
  EveningCloseoutStore,
  Recommendations,
  generateEveningCloseout,
  parseEveningCloseoutInput,
} from "../../src/index.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { tempDb } from "../helpers.js";
import { closeoutInput, signer, trustedCloseoutKey } from "../fixtures/evening-closeout.js";
import { persistTask18Context, RECOMMENDATION_ID, RECOMMENDATION_NOW, task18Request } from "../fixtures/recommendation-fixture.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture(closeoutKey: TrustedCloseoutKey | null = trustedCloseoutKey): Promise<{ readonly db: AuthorityDb; readonly server: DashboardServer; readonly contextId: string }> {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  roots.push(dirname(db.filename));
  const context = persistTask18Context(db);
  new Recommendations(db).create(task18Request(context));
  const root = mkdtempSync(join(tmpdir(), "jarvis-personal-integrity-"));
  roots.push(root);
  writeFileSync(join(root, "index.html"), "<!doctype html>", "utf8");
  const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0,
    clock: () => new Date(RECOMMENDATION_NOW), ...(closeoutKey === null ? {} : { trustedCloseoutKey: closeoutKey }) });
  return { db, server, contextId: context.id };
}

async function get(server: DashboardServer, path: string): Promise<{ readonly status: number; readonly body: string }> {
  const response = await request(`http://${server.address.host}:${server.address.port}${path}`);
  return { status: response.statusCode, body: await response.body.text() };
}
function changes(db: AuthorityDb): number {
  const value: unknown = db.db.prepare("SELECT total_changes() AS count").get();
  return typeof value === "object" && value !== null && "count" in value && typeof value.count === "number" ? value.count : -1;
}
function expectSafeFailure(response: { readonly status: number; readonly body: string }): void {
  expect(response.status).toBe(500);
  expect(response.body).toContain('"code":"INTERNAL_ERROR"');
  expect(response.body).not.toContain("SELECT");
  expect(response.body).not.toContain("PERSONAL_");
}
function seedNotifications(db: AuthorityDb, count: number, prefix = "seed"): void {
  for (let index = 0; index < count; index += 1) {
    const at = `2026-08-28T11:0${String(index)}:00.000Z`;
    db.db.prepare(
      `INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,
       redacted_preview,deep_link,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(`${prefix}-${index}`, `${prefix}-corr-${index}`, `${prefix}-idem-${index}`, `${prefix}-dedup-${index}`,
      "action", "browser", `Preview ${index}`, `/decisions/${index}`, "created", "2026-08-28T13:00:00.000Z", at, at);
  }
}
function jsonRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("JSON record expected");
  return Object.fromEntries(Object.entries(parsed));
}
function fieldRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("field record expected");
  return Object.fromEntries(Object.entries(value));
}

describe("personal persisted projection integrity", () => {
  it("rejects a Today context envelope whose canonical digest no longer matches", async () => {
    // Given
    const { db, server, contextId } = await fixture();
    db.db.exec("DROP TRIGGER personal_context_snapshots_immutable_update");
    const row: unknown = db.db.prepare("SELECT canonical_envelope_json FROM personal_context_snapshots WHERE context_id=?").get(contextId);
    if (typeof row !== "object" || row === null || !("canonical_envelope_json" in row)
      || typeof row.canonical_envelope_json !== "string") throw new Error("context fixture expected");
    const envelope: unknown = JSON.parse(row.canonical_envelope_json);
    if (typeof envelope !== "object" || envelope === null || !("payload" in envelope)
      || typeof envelope.payload !== "object" || envelope.payload === null) throw new Error("payload expected");
    const changed = { ...envelope, payload: { ...envelope.payload, omissions: ["corrupted omission"] } };
    db.db.prepare("UPDATE personal_context_snapshots SET canonical_envelope_json=? WHERE context_id=?")
      .run(JSON.stringify(changed), contextId);
    const before = changes(db);
    try {
      // When
      const response = await get(server, "/api/v1/today");
      // Then
      expectSafeFailure(response);
      expect(changes(db)).toBe(before);
    } finally { server.close(); db.close(); }
  });

  it("rejects changed persisted evidence provenance without partial recommendation data", async () => {
    // Given
    const { db, server } = await fixture();
    db.db.exec("DROP TRIGGER personal_context_evidence_immutable_update");
    db.db.prepare("UPDATE personal_context_evidence SET evidence_kind='corrupted_kind' WHERE position=0").run();
    const before = changes(db);
    try {
      // When
      const response = await get(server, `/api/v1/recommendations/${encodeURIComponent(RECOMMENDATION_ID)}`);
      // Then
      expectSafeFailure(response);
      expect(response.body).not.toContain(RECOMMENDATION_ID);
      expect(changes(db)).toBe(before);
    } finally { server.close(); db.close(); }
  });

  it.each([null, { ...trustedCloseoutKey, key_id: "different-trusted-key" }, trustedCloseoutKey])("does not trust a closeout's own public key (%j)", async key => {
    const { db, server } = await fixture(key);
    const at = new Date("2026-08-28T12:00:00.000Z");
    const loop = new DailyLoopStore(db);
    const runId = loop.prepare({ due: { kind: "due", local_date: "2026-08-28", phase: "evening",
      scheduled_at: at.toISOString() }, created_at: at, deadline_at: new Date("2026-08-28T13:00:00.000Z"),
    steps: [{ key: "evening_summary", sequence: 1 }] });
    const claim = loop.claim({ run_id: runId, owner_id: "integrity-owner", at, lease_ms: 600_000 });
    const correlation = db.db.prepare("SELECT correlation_id FROM daily_loop_runs WHERE run_id=?").get(runId);
    if (typeof correlation !== "object" || correlation === null || !("correlation_id" in correlation)) {
      throw new Error("correlation expected");
    }
    const input = closeoutInput();
    const artifact = generateEveningCloseout(parseEveningCloseoutInput({ ...input, local_date: "2026-08-28", run_id: runId,
      correlation_id: String(correlation.correlation_id), generated_at: at.toISOString(), records: [], decisions: [],
      memory_candidates: [], tomorrow_actions: [], risks: [] }), signer(at.toISOString()));
    new EveningCloseoutStore(db, trustedCloseoutKey).settle({ claim, artifact, at });
    try {
      const response = await get(server, "/api/v1/today");
      if (key === null) {
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body).latest_verified_closeout).toBeNull();
      } else if (key.key_id === trustedCloseoutKey.key_id) {
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body).latest_verified_closeout).toMatchObject({ artifact_id: artifact.artifact_id, verified_completion_count: 0 });
        expect(todayProjection(db, new Date(at.getTime() - 1), key)["latest_verified_closeout"]).toBeNull();
      } else expectSafeFailure(response);
    } finally { server.close(); db.close(); }
  });

  it("rejects a corrupted persisted closeout signature", async () => {
    // Given
    const { db, server } = await fixture();
    const at = new Date("2026-08-30T12:00:00.000Z");
    const loop = new DailyLoopStore(db);
    const runId = loop.prepare({ due: { kind: "due", local_date: "2026-08-30", phase: "evening",
      scheduled_at: at.toISOString() }, created_at: at, deadline_at: new Date("2026-08-30T13:00:00.000Z"),
    steps: [{ key: "evening_summary", sequence: 1 }] });
    const claim = loop.claim({ run_id: runId, owner_id: "integrity-owner", at, lease_ms: 600_000 });
    const correlation = db.db.prepare("SELECT correlation_id FROM daily_loop_runs WHERE run_id=?").get(runId);
    if (typeof correlation !== "object" || correlation === null || !("correlation_id" in correlation)) {
      throw new Error("correlation expected");
    }
    const input = closeoutInput();
    const artifact = generateEveningCloseout(parseEveningCloseoutInput({ ...input, run_id: runId,
      correlation_id: String(correlation.correlation_id), generated_at: at.toISOString(), records: [], decisions: [],
      memory_candidates: [], tomorrow_actions: [], risks: [] }), signer(at.toISOString()));
    new EveningCloseoutStore(db, trustedCloseoutKey).settle({ claim, artifact, at });
    db.db.exec("DROP TRIGGER daily_loop_steps_terminal_immutable; DROP TRIGGER daily_loop_steps_digest_material");
    const prefix = artifact.envelope.signature.startsWith("A") ? "B" : "A";
    const corrupted = { ...artifact, envelope: { ...artifact.envelope, signature: `${prefix}${artifact.envelope.signature.slice(1)}` } };
    db.db.prepare("UPDATE daily_loop_steps SET detail_json=? WHERE run_id=? AND step_key='evening_summary'")
      .run(JSON.stringify(corrupted), runId);
    const before = changes(db);
    try {
      // When
      const response = await get(server, "/api/v1/today");
      // Then
      expectSafeFailure(response);
      expect(changes(db)).toBe(before);
    } finally { server.close(); db.close(); }
  });

  it("keeps HTTP snapshot total and membership stable after an older insertion", async () => {
    // Given
    const { db, server } = await fixture();
    seedNotifications(db, 3);
    try {
      const first = jsonRecord((await get(server, "/api/v1/notification-intents?limit=2")).body);
      const page = fieldRecord(first["page"]);
      const cursor = page["next_cursor"];
      if (typeof cursor !== "string") throw new Error("page cursor expected");
      seedNotifications(db, 1, "inserted");
      const before = changes(db);
      // When
      const second = jsonRecord((await get(server,
        `/api/v1/notification-intents?limit=2&cursor=${encodeURIComponent(cursor)}`)).body);
      // Then
      expect(fieldRecord(second["page"])["total"]).toBe(3);
      expect(JSON.stringify(second)).not.toContain("inserted");
      expect(changes(db)).toBe(before);
    } finally { server.close(); db.close(); }
  });

  it("returns the exact stale-cursor error when an HTTP anchor changes", async () => {
    // Given
    const { db, server } = await fixture();
    seedNotifications(db, 3);
    const first = jsonRecord((await get(server, "/api/v1/notification-intents?limit=2")).body);
    const cursor = fieldRecord(first["page"])["next_cursor"];
    if (typeof cursor !== "string") throw new Error("page cursor expected");
    db.db.exec("DROP TRIGGER notification_intents_identity_immutable");
    db.db.prepare("UPDATE notification_intents SET redacted_preview='Changed preview' WHERE intent_id='seed-1'").run();
    const before = changes(db);
    try {
      // When
      const response = await get(server,
        `/api/v1/notification-intents?limit=2&cursor=${encodeURIComponent(cursor)}`);
      // Then
      expect(response.status).toBe(400);
      expect(response.body).toContain('"code":"PERSONAL_CURSOR_STALE"');
      expect(changes(db)).toBe(before);
    } finally { server.close(); db.close(); }
  });

  it("rejects persisted evidence cardinality loss", async () => {
    // Given
    const { db, server } = await fixture();
    db.db.exec("DROP TRIGGER personal_recommendation_evidence_immutable_delete");
    db.db.prepare("DELETE FROM personal_recommendation_evidence WHERE recommendation_id=? AND position=0").run(RECOMMENDATION_ID);
    const before = changes(db);
    try {
      // When
      const response = await get(server, `/api/v1/recommendations/${encodeURIComponent(RECOMMENDATION_ID)}`);
      // Then
      expectSafeFailure(response);
      expect(changes(db)).toBe(before);
    } finally { server.close(); db.close(); }
  });

  it("rejects a schema-valid recommendation lifecycle state outside its canonical envelope", async () => {
    const { db, server } = await fixture();
    db.db.exec("DROP TRIGGER personal_recommendations_immutable_update");
    db.db.prepare(
      "UPDATE personal_recommendations SET lifecycle_state='selected' WHERE recommendation_id=?",
    ).run(RECOMMENDATION_ID);
    const before = changes(db);
    try {
      const response = await get(server, `/api/v1/recommendations/${encodeURIComponent(RECOMMENDATION_ID)}`);
      expectSafeFailure(response);
      expect(response.body).not.toContain('"lifecycle_state":"selected"');
      expect(changes(db)).toBe(before);
    } finally { server.close(); db.close(); }
  });

  it("rejects a context evidence position outside its canonical index", async () => {
    const { db, server } = await fixture();
    db.db.exec("DROP TRIGGER personal_context_evidence_immutable_update");
    db.db.prepare(
      `UPDATE personal_context_evidence SET position=31
       WHERE context_id=(SELECT context_id FROM personal_recommendations WHERE recommendation_id=?)
         AND position=0`,
    ).run(RECOMMENDATION_ID);
    const before = changes(db);
    try {
      const response = await get(server, `/api/v1/recommendations/${encodeURIComponent(RECOMMENDATION_ID)}`);
      expectSafeFailure(response);
      expect(changes(db)).toBe(before);
    } finally { server.close(); db.close(); }
  });
});
