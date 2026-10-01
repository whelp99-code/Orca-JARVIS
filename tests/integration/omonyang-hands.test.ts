import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/authority-db.js";
import { loadAgentToken } from "../../src/omonyang-hands/auth.js";
import { HandsError } from "../../src/omonyang-hands/errors.js";
import { HandsService } from "../../src/omonyang-hands/hands.js";
import { createOmonyangHandsMcp } from "../../src/omonyang-hands/mcp.js";
import { approvalMode } from "../../src/omonyang-hands/policy.js";
import { HandsStore } from "../../src/omonyang-hands/store.js";
import { FileVault } from "../../src/omonyang-hands/vault.js";

const TOKEN = "omonyang-token-0123456789abcdef0123456789";
const DIGEST = `sha256:${"ab".repeat(32)}`;

function fixture(now = new Date("2026-10-02T00:00:00.000Z")) {
  const root = mkdtempSync(join(tmpdir(), "omonyang-hands-"));
  const tokenPath = join(root, "token.json");
  writeFileSync(tokenPath, JSON.stringify({ agent: "agent:omonyang", token: TOKEN }), { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  const token = loadAgentToken(tokenPath);
  const store = new HandsStore(join(root, "hands.sqlite"));
  const vault = new FileVault(join(root, "vault"));
  const service = new HandsService(token, store, vault, "stdio", () => now);
  return { root, tokenPath, store, vault, service, now };
}

describe("omonyang hands", () => {
  it("rejects a world-readable token and a public bind", () => {
    const root = mkdtempSync(join(tmpdir(), "omonyang-token-"));
    const path = join(root, "token.json");
    writeFileSync(path, JSON.stringify({ agent: "agent:omonyang", token: TOKEN }));
    chmodSync(path, 0o644);
    expect(() => loadAgentToken(path)).toThrow(HandsError);
    const ok = fixture();
    expect(() => new HandsService(loadAgentToken(ok.tokenPath), ok.store, ok.vault, "8.8.8.8")).toThrow(HandsError);
    expect(approvalMode("mail.draft")).toBe("log");
    expect(approvalMode("sb.remember")).toBe("log");
    ok.store.close();
  });

  it("audits a vault remember/search/read without approval", async () => {
    const fx = fixture();
    const remembered = await fx.service.call("sb.remember", { title: "tax note", body: "keep the receipt", page_id: "taxnote" }, TOKEN);
    expect(remembered.data["page_id"]).toBe("taxnote");
    const found = await fx.service.call("sb.search", { query: "receipt" }, TOKEN);
    expect(found.data["results"]).toEqual([expect.objectContaining({ page_id: "taxnote" })]);
    const page = await fx.service.call("sb.read", { page_id: "taxnote" }, TOKEN);
    expect(page.data["body"]).toBe("keep the receipt");
    expect(fx.store.audits().every(row => row.agent === "agent:omonyang" && row.approval === "log" && row.error_code === null)).toBe(true);
    await expect(fx.service.call("sb.read", { page_id: "missing1" }, TOKEN)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fx.store.audits().some(row => row.error_code === "NOT_FOUND")).toBe(true);
    fx.store.close();
  });

  it("stages a batch approval and hides a digest mismatch", async () => {
    const fx = fixture();
    const staged = await fx.service.call("jarvis.request_approval", {
      items: [{
        action_kind: "mail.send",
        summary: "send the invoice draft",
        payload_digest: DIGEST,
        expires_in_seconds: 900,
        mail_draft_id: "draft-1",
        request_id: "req_mail_send_1",
      }, {
        action_kind: "payment",
        summary: "pay the vendor",
        payload_digest: DIGEST,
        expires_in_seconds: 900,
      }],
    }, TOKEN);
    const requests = staged.data["requests"] as Array<{ request_id: string }>;
    expect(requests).toHaveLength(2);
    expect(requests[0]?.request_id).toBe("req_mail_send_1");
    const status = await fx.service.call("jarvis.approval_status", { request_id: "req_mail_send_1", payload_digest: DIGEST }, TOKEN);
    expect(status.data["state"]).toBe("pending");
    await expect(fx.service.call("jarvis.approval_status", {
      request_id: "req_mail_send_1",
      payload_digest: `sha256:${"cd".repeat(32)}`,
    }, TOKEN)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(fx.service.call("jarvis.request_approval", {
      items: [{
        action_kind: "mail.send", summary: "changed", payload_digest: `sha256:${"cd".repeat(32)}`,
        expires_in_seconds: 900, mail_draft_id: "draft-1", request_id: "req_mail_send_1",
      }],
    }, TOKEN)).rejects.toMatchObject({ code: "CONFLICT" });
    fx.store.decide("req_mail_send_1", "approved");
    const approved = await fx.service.call("jarvis.approval_status", { request_id: "req_mail_send_1" }, TOKEN);
    expect(approved.data).toMatchObject({ state: "approved", manual_wait: true });
    fx.store.close();
  });

  it("creates a mail draft through the gateway and refuses send", async () => {
    const fx = fixture();
    const authority = new AuthorityDb(":memory:");
    await authority.migrate();
    const mail = new HandsService(loadAgentToken(fx.tokenPath), fx.store, fx.vault, "127.0.0.1", () => fx.now, {
      authority,
      origin: "http://127.0.0.1:9",
      http: {
        async request() {
          return { status: 201, body: { draft: { draft_id: "d-1", status: "needs_approval", payload_digest: DIGEST } } };
        },
      },
    });
    const card = await mail.call("mail.draft", {
      operation_id: "op-mail-1", to: "a@example.com", subject: "hello", body: "draft only",
    }, TOKEN);
    expect(card.data).toMatchObject({ draft_id: "d-1", sent: false });
    await expect(mail.call("mail.draft", {
      operation_id: "op-mail-1", to: "a@example.com", subject: "hello", body: "draft only", send: true,
    }, TOKEN)).rejects.toMatchObject({ code: "FORBIDDEN_SEND" });
    authority.close();
    fx.store.close();
  });

  it("keeps calendar and workboard local and rate-limits approval creates", async () => {
    const fx = fixture();
    const draft = await fx.service.call("calendar.create_draft", {
      title: "studio move", starts_at: "2026-10-03T01:00:00.000Z", ends_at: "2026-10-03T02:00:00.000Z",
    }, TOKEN);
    expect(draft.data["transmitted"]).toBe(false);
    const listed = await fx.service.call("calendar.list", { day: "2026-10-03" }, TOKEN);
    expect(listed.data["drafts"]).toHaveLength(1);
    await fx.service.call("workboard.update", { card_id: "card-1", title: "move", status: "doing" }, TOKEN);
    const board = await fx.service.call("workboard.list", {}, TOKEN);
    expect(board.data["cards"]).toEqual([expect.objectContaining({ card_id: "card-1", status: "doing" })]);
    for (let i = 0; i < 10; i += 1) {
      await fx.service.call("jarvis.request_approval", {
        items: [{ action_kind: "tax.transmit", summary: `file ${i}`, payload_digest: DIGEST, expires_in_seconds: 900 }],
      }, TOKEN);
    }
    await expect(fx.service.call("jarvis.request_approval", {
      items: [{ action_kind: "tax.transmit", summary: "over", payload_digest: DIGEST, expires_in_seconds: 900 }],
    }, TOKEN)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(fx.service.call("sb.search", { query: "x" }, "wrong-token-wrong-token-wrong-token")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    const server = createOmonyangHandsMcp(fx.service);
    expect(server).toBeTruthy();
    fx.store.close();
  });
});
