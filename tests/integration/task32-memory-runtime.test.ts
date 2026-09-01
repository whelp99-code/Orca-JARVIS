import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt } from "../../src/control-plane.js";
import type { SecondBrainEvidence, SecondBrainReadAdapter,
  SecondBrainReadOutcome } from "../../src/second-brain-adapter-types.js";
import { AuthorityDb } from "../../src/db.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { bindExternal, externalAnchors, localKey, tempDb } from "../helpers.js";

const NOW = new Date("2026-09-01T00:00:00.000Z");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function evidence(sensitivity: "personal" | "restricted", suffix: string): SecondBrainEvidence {
  return { kind: "memory", page_id: `wiki/task32-${suffix}`, sid: `1234567${suffix}`,
    source_ref: sensitivity === "restricted" ? "Private source" : "Second Brain",
    source_id: "src:pos:v1:second-brain:primary", source_version: "sb/0.1.0|v1|task32",
    sensitivity, observed_at: NOW.toISOString(), valid_at: NOW.toISOString(),
    freshness: { state: "fresh", checked_at: NOW.toISOString(),
      fresh_until: "2026-09-01T01:00:00.000Z" }, expires_at: "2026-09-02T00:00:00.000Z",
    trust: "untrusted", authority: "none", excerpt: sensitivity === "restricted" ? null : "Fictional record",
    content_digest: `sha256:${suffix.repeat(64)}`, omission: sensitivity === "restricted" ? "policy_redacted" : null,
    record: { record_id: `sbrecord:v1:${suffix.repeat(64)}`, record_digest: `sha256:${suffix.repeat(64)}`,
      source_identity_full: "a".repeat(64), content_identity_full: "b".repeat(64),
      citation_identity_full: "c".repeat(64), source_owner_class: "provider_owned",
      source_owner_id_digest: `sha256:${"d".repeat(64)}`, origin_label: "Second Brain",
      generation: { provider_instance_id: "provider:task32", generation_id: `sbgen:v1:${"e".repeat(64)}`,
        generation_manifest_digest: `sha256:${"f".repeat(64)}`, vault_head: "1".repeat(40),
        vault_tree: "2".repeat(40), tombstone_sequence: 0,
        tombstone_set_root: `sha256:${"3".repeat(64)}` } } };
}
class RuntimeAdapter implements SecondBrainReadAdapter {
  readonly contract_profile = "schema4" as const;
  readonly left = evidence("personal", "4"); readonly right = evidence("restricted", "5");
  search(): Promise<SecondBrainReadOutcome> { return Promise.resolve({ kind: "current",
    checked_at: NOW.toISOString(), evidence: [this.left] }); }
  readPage(): Promise<SecondBrainReadOutcome> { return this.search(); }
  recentChanges(): Promise<SecondBrainReadOutcome> { return this.search(); }
  openConflicts(): Promise<SecondBrainReadOutcome> { return Promise.resolve({ kind: "conflicts",
    checked_at: NOW.toISOString(), conflicts: [{ conflict_id: "conflicts/task32", page_id: this.left.page_id,
      state: "unresolved", left: this.left, right: this.right }] }); }
}
async function fixture() {
  const db = new AuthorityDb(tempDb()); const anchors = externalAnchors();
  roots.push(dirname(anchors.decisionPublic));
  await db.initialize({ decision: { keyId: "decision-test", principal: "principal:owner",
    publicKeyPath: anchors.decisionPublic }, verifier: { keyId: "verifier-test",
    principal: "independent-verifier", publicKeyPath: anchors.verifierPublic } });
  bindExternal(db, anchors);
  const root = mkdtempSync(join(tmpdir(), "task32-memory-runtime-")); roots.push(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>");
  const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0,
    clock: () => NOW, memoryAdapter: new RuntimeAdapter(), memoryProjectionKey: Buffer.alloc(32, 7) });
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

describe("Task 32 bound Memory runtime", () => {
  it("projects conflict sides without private text", async () => {
    const value = await fixture();
    try {
      const response = await call(value, "/api/v1/memory/conflicts?state=unresolved&limit=20");
      expect(response.status).toBe(200);
      expect(response.body.items).toEqual([{ conflict_revision: expect.stringMatching(/^hmac-sha256:/),
        subject: "[REDACTED]", state: "unresolved", sides: [
          { sensitivity: "personal", citation: "Memory citation" },
          { sensitivity: "restricted", citation: "Private citation" }] }]);
      expect(JSON.stringify(response.body)).not.toMatch(/Fictional record|[a-f0-9]{64}\/task32/);
    } finally { value.server.close(); value.db.close(); }
  });

  it("stages an exact record-bound forget and suppresses it at owner approval", async () => {
    const value = await fixture();
    try {
      const search = await call(value, "/api/v1/memory/search", {
        schema_version: 1, query: "fictional", limit: 20 });
      const item = search.body.items[0];
      const staged = await call(value, "/api/v1/memory/records/actions/forget", {
        schema_version: 1, intent_id: `memui:intent:v1:${"6".repeat(64)}`,
        record_token: item.record_token, record_revision: item.record_revision,
        payload: { acknowledge_irreversible: true, erasure_claim: "managed_erasure" } });
      expect(staged.status).toBe(202);
      const target = value.db.db.prepare(
        `SELECT provider_instance_id,generation_id,source_membership_hmac,content_membership_hmac,
         citation_membership_hmac,record_membership_hmac,suppression_epoch
         FROM memory_surface_target_versions`,
      ).get() as Record<string, unknown>;
      expect(target).toMatchObject({ provider_instance_id: "provider:task32",
        generation_id: `sbgen:v1:${"e".repeat(64)}`, suppression_epoch: 0 });
      expect(Object.values(target).filter(entry => typeof entry === "string" && entry.startsWith("hmac-sha256:")))
        .toHaveLength(4);
      expect(JSON.stringify(target)).not.toContain("a".repeat(64));
      const control = new ControlPlane(value.db);
      const command = control.list().find(row => row.request_id === staged.body.request_id);
      if (command === undefined) throw new Error("staged command missing");
      const unsigned: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1,
        receipt_id: `approval:${command.request_id}`, request_id: command.request_id, decision: "approve",
        command_digest: command.command_digest, signer_principal_id: "principal:owner",
        authenticated_session_id: "owner-session", key_id: "decision-test", algorithm: "Ed25519",
        issued_at: NOW.toISOString(), not_before: NOW.toISOString(), expires_at: command.expires_at,
        nonce: "task32-memory-forget-approval", max_uses: 1, status: "issued" };
      control.decide(signCommandApproval(unsigned, localKey(value.db)), NOW);
      expect(value.db.db.prepare(
        "SELECT privacy_epoch,suppression_sequence FROM memory_surface_authority WHERE singleton_id=1").get())
        .toEqual({ privacy_epoch: 1, suppression_sequence: 1 });
      expect(value.db.db.prepare("SELECT operation FROM memory_surface_suppressions").get())
        .toEqual({ operation: "forget" });
    } finally { value.server.close(); value.db.close(); }
  });
});
