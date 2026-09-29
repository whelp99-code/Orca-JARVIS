import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt } from "../../src/control-plane.js";
import { AuthorityDb } from "../../src/db.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { bindExternal, externalAnchors, localKey, tempDb } from "../helpers.js";
import { MEMORY_TOMBSTONE_GENESIS_ROOT } from "../../src/second-brain-effect-v2-contract.js";
import { TASK32_NOW, Task32ReadAdapter, task32Evidence } from "../fixtures/task32-memory-test-support.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ORIGINAL_TEXT = "Synthetic Task 32 record";
const OTHER_TEXT = "Unrelated Task 32 record";

async function fixture(originLabel = "Second Brain") {
  const db = new AuthorityDb(tempDb()); const anchors = externalAnchors();
  roots.push(dirname(anchors.decisionPublic));
  await db.initialize({ decision: { keyId: "decision-test", principal: "principal:owner",
    publicKeyPath: anchors.decisionPublic }, verifier: { keyId: "verifier-test",
    principal: "independent-verifier", publicKeyPath: anchors.verifierPublic } });
  bindExternal(db, anchors);
  const root = mkdtempSync(join(tmpdir(), "task32-memory-history-")); roots.push(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>");
  const target = task32Evidence({ suffix: "1", tombstoneSetRoot: MEMORY_TOMBSTONE_GENESIS_ROOT });
  const labeled = { ...target, record: { ...target.record!, origin_label: originLabel } };
  const other = { ...task32Evidence({ suffix: "2", excerpt: OTHER_TEXT, tombstoneSetRoot: MEMORY_TOMBSTONE_GENESIS_ROOT }),
    record: { ...task32Evidence({ suffix: "2" }).record!, source_identity_full: "9".repeat(64),
      content_identity_full: "8".repeat(64), citation_identity_full: "7".repeat(64) } };
  const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0,
    clock: () => TASK32_NOW, memoryAdapter: new Task32ReadAdapter([labeled, other]),
    memoryProjectionKey: Buffer.alloc(32, 7) });
  const origin = `http://${server.address.host}:${server.address.port}`;
  const session = await request(`${origin}/api/v1/session`); const sessionBody = JSON.parse(await session.body.text());
  return { db, server, origin, token: String(Reflect.get(sessionBody, "csrf_token")) };
}
async function call(value: Awaited<ReturnType<typeof fixture>>, path: string, body?: unknown) {
  const response = await request(`${value.origin}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { "X-JARVIS-CSRF": value.token, ...(body === undefined ? {}
      : { "Content-Type": "application/json", Origin: value.origin }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.statusCode, body: JSON.parse(await response.body.text()) };
}
function approve(db: AuthorityDb, requestId: string): string {
  const control = new ControlPlane(db);
  const command = control.list().find(row => row.request_id === requestId);
  if (command === undefined) throw new Error("staged command missing");
  const receiptId = `approval:${command.request_id}`;
  const unsigned: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1,
    receipt_id: receiptId, request_id: command.request_id, decision: "approve",
    command_digest: command.command_digest, signer_principal_id: "principal:owner",
    authenticated_session_id: "owner-session", key_id: "decision-test", algorithm: "Ed25519",
    issued_at: TASK32_NOW.toISOString(), not_before: TASK32_NOW.toISOString(), expires_at: command.expires_at,
    nonce: `task32-history-${command.request_id}`, max_uses: 1, status: "issued" };
  control.decide(signCommandApproval(unsigned, localKey(db)), TASK32_NOW);
  return receiptId;
}
async function search(value: Awaited<ReturnType<typeof fixture>>) {
  return call(value, "/api/v1/memory/search", { schema_version: 1, query: "synthetic", limit: 20 });
}

describe("Task 32 Memory record history", () => {
  it("reports a current record with an empty bounded history before any owner command", async () => {
    // Given a bound provider record with no authority decisions
    const value = await fixture();
    try {
      // When the owner searches
      const response = await search(value);
      // Then the record carries its lineage fields and an empty history
      expect(response.status).toBe(200);
      expect(response.body.items[0]).toMatchObject({ history_state: "current", superseded_by: null,
        history: [], citation: "Memory citation", excerpt: ORIGINAL_TEXT });
    } finally { value.server.close(); value.db.close(); }
  });

  it("shows a staged correction in the record history while it awaits approval", async () => {
    // Given a staged correction against the record
    const value = await fixture();
    try {
      const first = await search(value); const item = first.body.items[0];
      const staged = await call(value, "/api/v1/memory/records/actions/correct", {
        schema_version: 1, intent_id: `memui:intent:v1:${"1".repeat(64)}`,
        record_token: item.record_token, record_revision: item.record_revision,
        payload: { replacement: "Corrected synthetic record" } });
      expect(staged.status).toBe(202);
      // When the owner searches again
      const second = await search(value);
      // Then the record is still current and its history names the pending attempt
      expect(second.body.items[0]).toMatchObject({ history_state: "current", excerpt: ORIGINAL_TEXT,
        history: [{ operation: "correct", state: "staged", request_id: staged.body.request_id,
          receipt_id: null, at: TASK32_NOW.toISOString() }] });
      expect(second.body.items[1]).toMatchObject({ excerpt: OTHER_TEXT, history: [] });
    } finally { value.server.close(); value.db.close(); }
  });

  it("marks an approved correction as superseded with its receipt and hides the old content", async () => {
    // Given an approved correction whose provider apply has not landed yet
    const value = await fixture();
    try {
      const first = await search(value); const item = first.body.items[0];
      const staged = await call(value, "/api/v1/memory/records/actions/correct", {
        schema_version: 1, intent_id: `memui:intent:v1:${"2".repeat(64)}`,
        record_token: item.record_token, record_revision: item.record_revision,
        payload: { replacement: "Corrected synthetic record" } });
      const receiptId = approve(value.db, staged.body.request_id);
      // When the owner searches again
      const second = await search(value);
      // Then the superseded record renders as metadata-only history, never its old text
      expect(second.status).toBe(200);
      expect(second.body.items).toHaveLength(2);
      expect(second.body.items[0]).toMatchObject({ history_state: "superseded", title: "Superseded record",
        excerpt: null, citation: "Superseded citation", actions: [], superseded_by: staged.body.request_id,
        history: [{ operation: "correct", state: "suppressed", request_id: staged.body.request_id,
          receipt_id: receiptId, at: TASK32_NOW.toISOString() },
        { operation: "correct", state: "approved", request_id: staged.body.request_id, receipt_id: null }] });
      expect(second.body.items[1]).toMatchObject({ history_state: "current", excerpt: OTHER_TEXT });
      expect(JSON.stringify(second.body)).not.toContain(ORIGINAL_TEXT);
      expect(JSON.stringify(second.body)).not.toContain("a".repeat(64));
    } finally { value.server.close(); value.db.close(); }
  });

  it("never returns a forgotten record, not even as history", async () => {
    // Given an approved forget against the record
    const value = await fixture();
    try {
      const first = await search(value); const item = first.body.items[0];
      const staged = await call(value, "/api/v1/memory/records/actions/forget", {
        schema_version: 1, intent_id: `memui:intent:v1:${"3".repeat(64)}`,
        record_token: item.record_token, record_revision: item.record_revision,
        payload: { acknowledge_irreversible: true, erasure_claim: "managed_erasure" } });
      approve(value.db, staged.body.request_id);
      // When the owner searches again
      const second = await search(value);
      // Then only the unrelated record remains
      expect(second.body.items.map((row: { excerpt: string | null }) => row.excerpt)).toEqual([OTHER_TEXT]);
      expect(JSON.stringify(second.body)).not.toContain(ORIGINAL_TEXT);
      expect(JSON.stringify(second.body)).not.toContain(staged.body.request_id);
    } finally { value.server.close(); value.db.close(); }
  });

  it("replaces a path-like provider origin label with a safe label", async () => {
    // Given a provider that labels its origin with a vault path
    const value = await fixture("Second Brain /vault/secret/atlas.md");
    try {
      // When the owner searches
      const response = await search(value);
      // Then no path reaches the public record
      expect(response.body.items[0].provenance.origin_label).toBe("Memory provider");
      expect(JSON.stringify(response.body)).not.toContain("/vault/");
    } finally { value.server.close(); value.db.close(); }
  });
});
