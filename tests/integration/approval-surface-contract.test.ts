import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JarvisControlServer } from "../../src/control-server.js";
import { defaultLocalSession, LocalAuthenticator } from "../../src/local-authenticator.js";
import { DispatchApprovalIngress } from "../../shells/cli-jaw/src/core/dispatch-approval.js";
import { renderApprovalSurface } from "../../shells/cli-jaw/src/messaging/approval-presentation.js";
import { ShellApprovalStore } from "../../shells/cli-jaw/src/jarvis/approval-intent.js";
import { future, initialized, localKey } from "../helpers.js";

function worktreeIntent(name = "approve-child") {
  return {
    ingressIdempotencyKey: `ingress-${name}`,
    repository: "/tmp/repo",
    parentPath: "/tmp/trees",
    branch: `feat/${name}`,
    name,
    requestedAt: new Date().toISOString(),
    expiresAt: future(10),
  };
}

describe("approval surface contract", () => {
  it("renders identical machine-consumed fields on web, tui, and electron", async () => {
    const db = await initialized();
    const session = defaultLocalSession();
    const server = new JarvisControlServer(db, session.principal);
    const staged = server.requestWorktree(worktreeIntent());
    const auth = new LocalAuthenticator(db, session, localKey(db));
    const view = auth.view(staged.request_id);
    const surfaces = (["web", "tui", "electron"] as const).map(surface => renderApprovalSurface(surface, view));
    expect(new Set(surfaces.map(item => JSON.stringify(item.fields))).size).toBe(1);
    expect(surfaces[0]?.fields).toMatchObject({
      requestId: staged.request_id,
      action: "worktree.create",
      reversible: true,
      digestPrefix: staged.command_digest.slice(0, 19),
      environment: "local",
      riskTier: 2,
    });
    expect(surfaces.every(item => item.focusOrder[0] === "action" && item.roles.approve === "button")).toBe(true);
    const receipt = auth.approve(staged.request_id, session);
    expect(receipt.command_digest).toBe(staged.command_digest);
    expect(auth.receiptCount()).toBe(1);
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/06/happy"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/06/happy/fields.json"), `${JSON.stringify({ view, surfaces }, null, 2)}\n`);
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/06/happy/a11y.json"), `${JSON.stringify(surfaces.map(item => ({ surface: item.surface, focusOrder: item.focusOrder, labels: item.labels, roles: item.roles })), null, 2)}\n`);
    db.close();
  });

  it("refuses callback mutations and forged local sessions without issuing a receipt", async () => {
    const db = await initialized();
    const session = defaultLocalSession();
    const server = new JarvisControlServer(db, session.principal);
    const staged = server.requestWorktree(worktreeIntent("deny-child"));
    const store = new ShellApprovalStore();
    const ingress = new DispatchApprovalIngress(store);
    const presented = ingress.display({
      intentId: "intent-1",
      requestId: staged.request_id,
      displayExpiry: future(10),
      generation: "gen-1",
      status: "displayed",
    });
    store.bindCallback({
      intentId: presented.intentId,
      channel: "telegram",
      account: "acct-1",
      sender: "user-1",
      thread: "thread-1",
      message: "msg-1",
      generation: "gen-1",
    });
    const refusals = [
      ingress.dispatch({
        intentId: "intent-1", channel: "telegram", account: "acct-1", sender: "user-1",
        thread: "thread-1", message: "msg-1", generation: "gen-1", action: "approve",
      }),
      ingress.dispatch({
        intentId: "intent-1", channel: "telegram", account: "acct-X", sender: "user-1",
        thread: "thread-1", message: "msg-1", generation: "gen-1", action: "deny",
      }),
      ingress.dispatch({
        intentId: "intent-1", channel: "telegram", account: "acct-1", sender: "user-1",
        thread: "thread-1", message: "msg-1", generation: "gen-2", action: "deny",
      }),
    ];
    store.setQueueingEnabled(false);
    const queued = ingress.dispatch({
      intentId: "intent-1", channel: "telegram", account: "acct-1", sender: "user-1",
      thread: "thread-1", message: "msg-1", generation: "gen-1", action: "queue_local",
    });
    const denied = ingress.dispatch({
      intentId: "intent-1", channel: "telegram", account: "acct-1", sender: "user-1",
      thread: "thread-1", message: "msg-1", generation: "gen-1", action: "deny",
    });
    const auth = new LocalAuthenticator(db, session, localKey(db));
    const forged = [
      { ...session, principal: "forged" },
      { ...session, sessionId: "other-session" },
      { ...session, host: "other-host" },
      { ...session, environment: "jm-server" },
    ];
    const forgeCodes = forged.map(claim => {
      try {
        auth.approve(staged.request_id, claim);
        return "UNEXPECTED_RECEIPT";
      } catch (error) {
        return error instanceof Error ? error.message : "unknown";
      }
    });
    expect(refusals.every(item => item.status === "refused")).toBe(true);
    expect(queued).toMatchObject({ status: "refused", code: "SHELL_QUEUEING_DISABLED" });
    expect(denied.status).toBe("denied");
    expect(forgeCodes.every(code => code === "LOCAL_AUTH_SESSION_MISMATCH")).toBe(true);
    expect(auth.receiptCount()).toBe(0);
    expect(store.snapshot().every(item => !("signature" in item) && !("command_digest" in item))).toBe(true);
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/06"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/06/failure.json"), `${JSON.stringify({
      refusals,
      queued,
      denied,
      forgeCodes,
      receipts: auth.receiptCount(),
    }, null, 2)}\n`);
    db.close();
  });
});
