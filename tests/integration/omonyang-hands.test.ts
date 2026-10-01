import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/authority-db.js";
import { loadAgentToken } from "../../src/omonyang-hands/auth.js";
import { HandsError } from "../../src/omonyang-hands/errors.js";
import { HandsService } from "../../src/omonyang-hands/hands.js";
import { createOmonyangHandsMcp } from "../../src/omonyang-hands/mcp.js";
import { StdioSbMcp } from "../../src/omonyang-hands/sb-client.js";
import { externalDelegateBatchDigest } from "../../src/external-delegate.js";
import { OwnerInbox } from "../../src/owner-inbox.js";
import { ControlReceiptSigner } from "../../src/remote-approval-signer.js";

const TOKEN = "omonyang-token-0123456789abcdef0123456789";
const DIGEST = `sha256:${"ab".repeat(32)}`;
const MAIL_ID = "11111111-1111-4111-8111-111111111111";

function event(id: string) {
  return {
    source: { host: "local", app: "omonyang", scope: "hands", generation: "1" },
    eventId: id, sequence: 1, sessionId: "sess-1", incarnation: "inc-1", taskId: null,
    receivedAt: "2026-10-02T00:00:00.000Z", sourceAt: "2026-10-02T00:00:00.000Z",
    state: "running", summary: "move the studio", evidenceRef: "ev-1",
  };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omonyang-hands-"));
  const tokenPath = join(root, "token.json");
  writeFileSync(tokenPath, JSON.stringify({ agent: "agent:omonyang", token: TOKEN }), { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  const authority = new AuthorityDb(join(root, "authority.sqlite"));
  await authority.migrate();
  const sb = new StdioSbMcp(process.execPath, [join(process.cwd(), "tests/fixtures/omonyang-sb-mcp.mjs")]);
  const service = new HandsService(loadAgentToken(tokenPath), authority, sb, "stdio", () => new Date("2026-10-02T00:00:00.000Z"));
  return { root, tokenPath, authority, service };
}

describe("omonyang hands", () => {
  it("rejects a world-readable token and a public bind", async () => {
    const fx = await fixture();
    const path = join(fx.root, "open.json");
    writeFileSync(path, JSON.stringify({ agent: "agent:omonyang", token: TOKEN }));
    chmodSync(path, 0o644);
    expect(() => loadAgentToken(path)).toThrow(HandsError);
    expect(() => new HandsService(loadAgentToken(fx.tokenPath), fx.authority, { async call() { return {}; } }, "8.8.8.8")).toThrow(HandsError);
    fx.authority.close();
  });

  it("passes sb_remember outcome codes through unchanged", async () => {
    const fx = await fixture();
    const written = await fx.service.call("sb.remember", { title: "WRITTEN", content: "note", request_id: "code-written" }, TOKEN);
    expect(written.data["outcome"]).toEqual({ code: "WRITTEN", written: true, delivery: "written", inbox_path: "inbox/note.md" });
    const none = await fx.service.call("sb.remember", { title: "NOTHING_WRITTEN", content: "note", request_id: "code-none" }, TOKEN);
    expect(none.data["outcome"]).toEqual({ code: "NOTHING_WRITTEN", written: false, delivery: "not_written", cause: "NOTHING_WRITTEN" });
    const follow = await fx.service.call("sb.remember", { title: "WRITTEN_WITH_FOLLOWUP_ERROR", content: "note", request_id: "code-follow" }, TOKEN);
    expect((follow.data["outcome"] as { code: string }).code).toBe("WRITTEN_WITH_FOLLOWUP_ERROR");
    const unknown = await fx.service.call("sb.remember", { title: "WRITE_OUTCOME_UNKNOWN", content: "note", request_id: "code-unknown" }, TOKEN);
    expect((unknown.data["outcome"] as { code: string }).code).toBe("WRITE_OUTCOME_UNKNOWN");
    const found = await fx.service.call("sb.search", { query: "receipt" }, TOKEN);
    expect(found.data["outcome"]).toEqual({ results: [{ page_id: "p1", title: "receipt" }] });
    const page = await fx.service.call("sb.read", { page_id: "p1" }, TOKEN);
    expect(page.data["outcome"]).toEqual({ page_id: "p1", body: "from-sb" });
    const audits = fx.authority.db.prepare("SELECT COUNT(*) AS n FROM audit_facts WHERE fact_type='omonyang_hands_call'").get() as { n: number };
    expect(audits.n).toBe(6);
    await expect(fx.service.call("sb.remember", { title: "note", content: "body" }, TOKEN)).rejects.toMatchObject({ code: "VALIDATION" });
    const first = await fx.service.call("sb.remember", { title: "note", content: "body", request_id: "same-id" }, TOKEN);
    const retry = await fx.service.call("sb.remember", { title: "note", content: "body", request_id: "same-id" }, TOKEN);
    expect(first.data["outcome"]).toMatchObject({ page_id: "page-1", pages: 1 });
    expect(retry.data["outcome"]).toEqual(first.data["outcome"]);
    const other = await fx.service.call("sb.remember", { title: "note", content: "body", request_id: "other-id" }, TOKEN);
    expect(other.data["outcome"]).toMatchObject({ page_id: "page-2", pages: 2 });
    fx.authority.close();
  });

  it("stages external.delegate into the owner inbox, not a second queue", async () => {
    const fx = await fixture();
    const items = [{ action_kind: "mail.send", summary: "send the invoice draft", payload_digest: DIGEST, mail_draft_id: MAIL_ID }];
    const staged = await fx.service.call("jarvis.request_approval", {
      request_id: "req_mail_1", batch_summary: "send the invoice draft", expires_in_seconds: 900, items,
    }, TOKEN);
    expect(staged.data["state"]).toBe("pending");
    const row = fx.authority.db.prepare("SELECT action, requested_by FROM control_command_requests WHERE request_id='req_mail_1'").get() as { action: string; requested_by: string };
    expect(row).toEqual({ action: "external.delegate", requested_by: "agent:omonyang" });
    const inbox = new OwnerInbox(fx.authority, new ControlReceiptSigner(generateKeyPairSync("ed25519").privateKey, "unused", "unused"), false, () => new Date("2026-10-02T00:00:00.000Z"));
    expect(inbox.list().find(item => item.request_id === "req_mail_1")?.requester_label).toBe("오모냥 요청");
    expect(fx.authority.db.prepare("SELECT name FROM sqlite_master WHERE name='omonyang_approvals'").get()).toBeUndefined();
    const batch_digest = externalDelegateBatchDigest(items);
    expect(staged.data["batch_digest"]).toBe(batch_digest);
    const status = await fx.service.call("jarvis.approval_status", { request_id: "req_mail_1", batch_digest }, TOKEN);
    expect(status.data["state"]).toBe("pending");
    await expect(fx.service.call("jarvis.approval_status", { request_id: "req_mail_1", batch_digest: `sha256:${"cd".repeat(32)}` }, TOKEN)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(fx.service.call("jarvis.request_approval", {
      request_id: "req_mail_1", batch_summary: "changed summary text", expires_in_seconds: 900, items,
    }, TOKEN)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(fx.service.call("jarvis.request_approval", {
      request_id: "req_mail_lie", batch_summary: "send the invoice draft", expires_in_seconds: 900, items,
      requested_by: "agent:grok-bot",
    }, TOKEN)).rejects.toMatchObject({ code: "AUTH_IDENTITY" });
    fx.authority.db.prepare("UPDATE control_command_requests SET state='approved' WHERE request_id='req_mail_1'").run();
    const approved = await fx.service.call("jarvis.approval_status", { request_id: "req_mail_1", batch_digest }, TOKEN);
    expect(approved.data).toMatchObject({ state: "approved", manual_wait: true });
    fx.authority.close();
  });

  it("creates a mail draft through the gateway and refuses send", async () => {
    const fx = await fixture();
    const mail = new HandsService(loadAgentToken(fx.tokenPath), fx.authority, { async call() { return {}; } }, "127.0.0.1", () => new Date("2026-10-02T00:00:00.000Z"), {
      origin: "http://127.0.0.1:9",
      http: { async request() { return { status: 201, body: { draft: { draft_id: "d-1", status: "needs_approval", payload_digest: DIGEST } } }; } },
    });
    const card = await mail.call("mail.draft", { operation_id: "op-mail-1", to: "a@example.com", subject: "hello", body: "draft only" }, TOKEN);
    expect(card.data).toMatchObject({ draft_id: "d-1", sent: false });
    await expect(mail.call("mail.draft", { operation_id: "op-mail-1", to: "a@example.com", subject: "hello", body: "draft only", send: true }, TOKEN)).rejects.toMatchObject({ code: "FORBIDDEN_SEND" });
    fx.authority.close();
  });

  it("ingests workboard events into WorkboardStore and rate-limits approvals", async () => {
    const fx = await fixture();
    const updated = await fx.service.call("workboard.update", { event: event("evt-1") }, TOKEN);
    expect(updated.data["result"]).toBe("inserted");
    const again = await fx.service.call("workboard.update", { event: event("evt-1") }, TOKEN);
    expect(again.data["result"]).toBe("replayed");
    const listed = await fx.service.call("workboard.list", {}, TOKEN);
    expect(listed.data["works"]).toEqual([expect.objectContaining({ summary: "move the studio", state: "running" })]);
    const items = [{ action_kind: "tax.transmit" as const, summary: "file", payload_digest: DIGEST }];
    for (let i = 0; i < 10; i += 1) {
      await fx.service.call("jarvis.request_approval", {
        request_id: `req_tax_${i}____`, batch_summary: `file ${i}`, expires_in_seconds: 900, items,
      }, TOKEN);
    }
    await expect(fx.service.call("jarvis.request_approval", {
      request_id: "req_tax_over__", batch_summary: "over", expires_in_seconds: 900, items,
    }, TOKEN)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(createOmonyangHandsMcp(fx.service)).toBeTruthy();
    fx.authority.close();
  });
});
