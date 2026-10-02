import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { approvedActionHasExecutor } from "../../src/approved-executor.js";
import { KNOWN_CONTROL_ACTIONS } from "../../src/control-actions.js";
import { canonicalize } from "../../src/canonical.js";
import { COMMAND_APPROVAL_DOMAIN, controlCommandDigest, verifyCommandApproval, type CommandApprovalReceipt, type ControlCommandRequestInput } from "../../src/control-plane.js";
import { ControlPlane } from "../../src/control-plane.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { externalDelegateBatchDigest } from "../../src/external-delegate.js";
import { OWNER_INBOX_EXTERNAL_DONE, OwnerInbox } from "../../src/owner-inbox.js";
import { knownRemoteMethods } from "../../src/phone-gateway-remote-routes.js";
import { ControlReceiptSigner } from "../../src/remote-approval-signer.js";
import { initialized, localKey } from "../helpers.js";

const NOW = new Date("2026-10-02T00:00:00.000Z");

function items() {
  return [
    { action_kind: "mail.send", summary: "send invoice", payload_digest: "sha256:" + "ab".repeat(32), mail_draft_id: "11111111-1111-4111-8111-111111111111" },
    { action_kind: "payment", summary: "pay vendor", payload_digest: "sha256:" + "cd".repeat(32) },
  ];
}

function stagedInput(): ControlCommandRequestInput {
  const batch = externalDelegateBatchDigest(items());
  return {
    schema_version: 1, request_id: "delegate-batch-01", action: "external.delegate", action_level: 3,
    target: { environment: "external", system: "grok-bot" },
    args: {
      source: "grok-bot", action_kind: "batch", summary: "두 건", batch_summary: "두 건",
      batch_digest: batch, payload_digest: batch, items: items(),
    },
    reversible: false, requested_by: "agent:grok-bot", requested_at: NOW.toISOString(),
    expires_at: "2026-10-02T02:00:00.000Z", nonce: "nonce-delegate-batch-01",
  };
}

describe("external.delegate", () => {
  it("is visible without an executor and shows the batch once", async () => {
    expect(KNOWN_CONTROL_ACTIONS).toContain("external.delegate");
    expect(approvedActionHasExecutor("external.delegate")).toBe(false);
    expect(knownRemoteMethods("/api/v1/internal/external-delegate")).toBeUndefined();
    const db = await initialized();
    const control = new ControlPlane(db);
    const staged = control.stage(stagedInput(), NOW);
    const inbox = new OwnerInbox(db, new ControlReceiptSigner(localKey(db), "decision-test", "test-operator"), true, () => NOW);
    const listed = inbox.list().find(item => item.request_id === staged.request_id);
    expect(listed?.summary).toBe("윤비서 요청 · 2건 묶음 · 30분 내 승인");
    expect(listed?.batch_items).toHaveLength(2);
    db.db.prepare("INSERT INTO owner_inbox_credentials(credential_id, public_key, counter, created_at) VALUES(?,?,?,?)")
      .run("cred-1", Buffer.from("pk"), 0, NOW.toISOString());
    const issued = inbox.issueChallenge({ request_id: staged.request_id, decision: "approve", command_digest: staged.command_digest, session_id: "session-1" });
    const decided = await inbox.decide({
      request_id: staged.request_id, decision: "approve", command_digest: staged.command_digest, session_id: "session-1",
      challenge_id: issued.challenge_id,
      assertion: { id: "cred-1", clientDataJSON: "", authenticatorData: "", signature: "", userHandle: "" },
      origin: "http://127.0.0.1", rpId: "127.0.0.1",
      check: async () => ({ ok: true, newCounter: 1 }),
    });
    expect(decided.state).toBe("approved");
    const after = inbox.list().find(item => item.request_id === staged.request_id);
    expect(after?.summary).toBe(OWNER_INBOX_EXTERNAL_DONE);
    expect(after?.manual_wait).toBe(true);
    const receipt = db.db.prepare("SELECT expires_at, issued_at FROM control_command_receipts WHERE request_id=?").get(staged.request_id) as { expires_at: string; issued_at: string };
    expect(Date.parse(receipt.expires_at) - Date.parse(receipt.issued_at)).toBe(30 * 60_000);
    const other = control.stage({
      schema_version: 1, request_id: "backup-ttl", action: "database.backup", action_level: 2,
      target: { environment: "local" }, args: { destination: "snap" }, reversible: true,
      requested_by: "principal:owner", requested_at: NOW.toISOString(), expires_at: "2026-10-02T02:00:00.000Z", nonce: "n-backup",
    }, NOW);
    const backupChallenge = inbox.issueChallenge({ request_id: other.request_id, decision: "approve", command_digest: other.command_digest, session_id: "session-1" });
    await inbox.decide({
      request_id: other.request_id, decision: "approve", command_digest: other.command_digest, session_id: "session-1",
      challenge_id: backupChallenge.challenge_id,
      assertion: { id: "cred-1", clientDataJSON: "", authenticatorData: "", signature: "", userHandle: "" },
      origin: "http://127.0.0.1", rpId: "127.0.0.1",
      check: async () => ({ ok: true, newCounter: 2 }),
    });
    const backupReceipt = db.db.prepare("SELECT expires_at, issued_at FROM control_command_receipts WHERE request_id=?").get(other.request_id) as { expires_at: string; issued_at: string };
    expect(Date.parse(backupReceipt.expires_at) - Date.parse(backupReceipt.issued_at)).toBe(10 * 60_000);
  });

  it("rejects a receipt signed by another key and a swapped digest", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const payload = {
      schema_version: 1 as const, receipt_id: "rcpt:1", request_id: "delegate-batch-01", decision: "approve" as const,
      command_digest: controlCommandDigest(stagedInput()), signer_principal_id: "test-operator",
      authenticated_session_id: "session-1", key_id: "decision-test", algorithm: "Ed25519" as const,
      issued_at: NOW.toISOString(), not_before: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 30 * 60_000).toISOString(), nonce: "n", max_uses: 1 as const, status: "issued" as const,
    };
    const signature = sign(null, Buffer.from(COMMAND_APPROVAL_DOMAIN + canonicalize(payload)), privateKey).toString("base64url");
    const receipt = { ...payload, signature } as CommandApprovalReceipt;
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyCommandApproval(receipt, pem, new Date(NOW.getTime() + 60_000))).toBe(true);
    expect(verifyCommandApproval(receipt, other.publicKey.export({ type: "spki", format: "pem" }).toString(), new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(verifyCommandApproval({ ...receipt, command_digest: "sha256:" + "00".repeat(32) }, pem, new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(verifyCommandApproval({ ...receipt, decision: "reject" }, pem, new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(verifyCommandApproval(receipt, pem, new Date(NOW.getTime() + 31 * 60_000))).toBe(false);
  });

  it("stages only external.delegate on the loopback route", async () => {
    const db = await initialized();
    const root = mkdtempSync(join(tmpdir(), "delegate-"));
    const tokenFile = join(root, "token");
    writeFileSync(tokenFile, "t".repeat(40));
    chmodSync(tokenFile, 0o600);
    process.env.JARVIS_EXTERNAL_DELEGATE_TOKEN_FILE = tokenFile;
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0, clock: () => NOW });
    const origin = `http://127.0.0.1:${server.address.port}`;
    const headers = { host: new URL(origin).host, "content-type": "application/json", "x-jarvis-delegate-token": "t".repeat(40) };
    try {
      const denied = await request(`${origin}/api/v1/internal/external-delegate`, { method: "POST", headers: { host: headers.host, "content-type": "application/json" }, body: "{}" });
      expect(denied.statusCode).toBe(401);
      const batch = externalDelegateBatchDigest(items());
      const created = await request(`${origin}/api/v1/internal/external-delegate`, {
        method: "POST", headers,
        body: JSON.stringify({ request_id: "delegate-batch-01", batch_summary: "두 건", batch_digest: batch, items: items(), expires_in_seconds: 1800 }),
      });
      expect(created.statusCode).toBe(201);
      const body = await created.body.json() as { command_digest: string; batch_digest: string };
      expect(body.batch_digest).toBe(batch);
      const hidden = await request(`${origin}/api/v1/internal/external-delegate/delegate-batch-01?batch_digest=sha256:${"00".repeat(32)}`, { headers });
      expect(hidden.statusCode).toBe(404);
      const pending = await request(`${origin}/api/v1/internal/external-delegate/delegate-batch-01?batch_digest=${batch}`, { headers });
      expect((await pending.body.json() as { state: string }).state).toBe("pending");
      const ignored = await request(`${origin}/api/v1/internal/external-delegate`, {
        method: "POST", headers,
        body: JSON.stringify({ request_id: "delegate-backup-1", action: "database.backup", batch_summary: "x", batch_digest: batch, items: items(), expires_in_seconds: 1800 }),
      });
      expect(ignored.statusCode).toBe(201);
      const stored = db.db.prepare("SELECT action FROM control_command_requests WHERE request_id='delegate-backup-1'").get() as { action: string };
      expect(stored.action).toBe("external.delegate");
    } finally {
      server.close();
      delete process.env.JARVIS_EXTERNAL_DELEGATE_TOKEN_FILE;
    }
  });

  it("rejects a batch whose item digests are not unique", async () => {
    const db = await initialized();
    const root = mkdtempSync(join(tmpdir(), "delegate-dup-"));
    const tokenFile = join(root, "token");
    writeFileSync(tokenFile, "t".repeat(40));
    chmodSync(tokenFile, 0o600);
    process.env.JARVIS_EXTERNAL_DELEGATE_TOKEN_FILE = tokenFile;
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0, clock: () => NOW });
    const origin = `http://127.0.0.1:${server.address.port}`;
    const shared = items()[0];
    const duplicated = [shared, { ...items()[1], payload_digest: shared?.payload_digest }];
    const batch = externalDelegateBatchDigest(duplicated);
    try {
      const rejected = await request(`${origin}/api/v1/internal/external-delegate`, {
        method: "POST",
        headers: { host: new URL(origin).host, "content-type": "application/json", "x-jarvis-delegate-token": "t".repeat(40) },
        body: JSON.stringify({ request_id: "delegate-dup-0001", batch_summary: "중복", batch_digest: batch, items: duplicated, expires_in_seconds: 1800 }),
      });
      expect(rejected.statusCode).toBe(400);
    } finally {
      server.close();
      delete process.env.JARVIS_EXTERNAL_DELEGATE_TOKEN_FILE;
    }
  });

  it("consumes an item once and rejects an expired receipt", async () => {
    const db = await initialized();
    const control = new ControlPlane(db);
    const staged = control.stage(stagedInput(), NOW);
    const inbox = new OwnerInbox(db, new ControlReceiptSigner(localKey(db), "decision-test", "test-operator"), true, () => NOW);
    db.db.prepare("INSERT INTO owner_inbox_credentials(credential_id, public_key, counter, created_at) VALUES(?,?,?,?)").run("cred-1", Buffer.from("pk"), 0, NOW.toISOString());
    const issued = inbox.issueChallenge({ request_id: staged.request_id, decision: "approve", command_digest: staged.command_digest, session_id: "session-1" });
    await inbox.decide({
      request_id: staged.request_id, decision: "approve", command_digest: staged.command_digest, session_id: "session-1",
      challenge_id: issued.challenge_id,
      assertion: { id: "cred-1", clientDataJSON: "", authenticatorData: "", signature: "", userHandle: "" },
      origin: "http://127.0.0.1", rpId: "127.0.0.1", check: async () => ({ ok: true, newCounter: 1 }),
    });
    const root = mkdtempSync(join(tmpdir(), "delegate-use-"));
    const tokenFile = join(root, "token");
    writeFileSync(tokenFile, "t".repeat(40));
    chmodSync(tokenFile, 0o600);
    process.env.JARVIS_EXTERNAL_DELEGATE_TOKEN_FILE = tokenFile;
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0, clock: () => NOW });
    const origin = `http://127.0.0.1:${server.address.port}`;
    const headers = { host: new URL(origin).host, "content-type": "application/json", "x-jarvis-delegate-token": "t".repeat(40) };
    const digest = items()[0]?.payload_digest ?? "";
    const consume = () => request(`${origin}/api/v1/internal/external-delegate/${staged.request_id}/consume`, {
      method: "POST", headers, body: JSON.stringify({ item_digest: digest }),
    });
    try {
      const [first, second] = await Promise.all([consume(), consume()]);
      const codes = [first.statusCode, second.statusCode].sort();
      expect(codes).toEqual([200, 409]);
    } finally {
      server.close();
    }
    const later = new Date(NOW.getTime() + 31 * 60_000);
    const expiredServer = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0, clock: () => later });
    const expiredOrigin = `http://127.0.0.1:${expiredServer.address.port}`;
    try {
      const expired = await request(`${expiredOrigin}/api/v1/internal/external-delegate/${staged.request_id}/consume`, {
        method: "POST",
        headers: { ...headers, host: new URL(expiredOrigin).host },
        body: JSON.stringify({ item_digest: items()[1]?.payload_digest }),
      });
      expect(expired.statusCode).toBe(404);
    } finally {
      expiredServer.close();
      delete process.env.JARVIS_EXTERNAL_DELEGATE_TOKEN_FILE;
    }
  });
});
