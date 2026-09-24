import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActionJournal } from "../../src/workboard/action-journal.js";
import { WorkboardActions } from "../../src/workboard/actions.js";
import { controlValueDigest } from "../../src/control-plane-contract.js";
import type { ActionBinding } from "../../src/workboard/action-contracts.js";
import { ACTION_NOW, actionRequest, startActionAgent } from "../fixtures/workboard-action-agent.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(request = actionRequest()) {
  const agent = await startActionAgent(request); cleanups.push(() => agent.close());
  const root = resolve(".runtime-tmp/workboard"); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "actions-test-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, "journal.sqlite");
  let db = new Database(filename); cleanups.push(() => { db.close(); });
  const { sourceId, workId, taskId, sessionId, attemptId, purposeVersion, specVersion } = agent.state.current;
  const binding: ActionBinding = { sourceId, workId, taskId, sessionId, attemptId, purposeVersion, specVersion };
  let now = ACTION_NOW;
  const adapters = new Map([[workId, agent.adapter]]);
  const service = () => new WorkboardActions(new ActionJournal(db), adapters, () => ({ ...binding }), () => now);
  let actions = service();
  return { agent, binding, get actions() { return actions; },
    advance() { now = new Date("2026-09-24T09:16:00.000Z"); },
    restart() { db.close(); db = new Database(filename); actions = service(); } };
}

describe("durable exact workboard intent", () => {
  it.each(["stop", "resume", "redirect"] as const)("%s is executable only as an explicit source request", async operation => {
    const request = actionRequest();
    request.payload = { command: `fixture-only:${operation}` }; request.payloadDigest = controlValueDigest(request.payload);
    request.effects = [{ operation, label: `fixture ${operation}`, resumesExecution: operation !== "stop" }];
    const f = await fixture(request); const prepared = await f.actions.prepare(f.binding.workId);
    expect(await f.actions.submit(prepared.token, operation)).toMatchObject({ status: "settled", receipt: { operation } });
    expect(f.agent.state.sends).toHaveLength(1);
    expect(f.agent.state.receiptReads).toBe(1);
  });
  it("double submit sends once and independently reads one source receipt", async () => {
    const f = await fixture(); const p = await f.actions.prepare(f.binding.workId);
    const results = await Promise.allSettled([f.actions.submit(p.token, "approve"), f.actions.submit(p.token, "approve")]);
    expect(f.agent.state.sends).toHaveLength(1);
    expect(results.every(r => r.status === "fulfilled")).toBe(true);
    expect(new Set(results.flatMap(r => r.status === "fulfilled" ? [r.value.intentId] : [])).size).toBe(1);
    expect(f.actions.journal.all()).toHaveLength(1);
    expect(f.actions.journal.all()[0]?.receipt?.sourceState).toBe("running");
    expect(f.agent.state.requestReads).toBeGreaterThanOrEqual(2);
    expect(f.agent.state.receiptReads).toBeGreaterThanOrEqual(1);
  });
  it("request replaced after dialog opened is not sent", async () => {
    const f = await fixture(); const p = await f.actions.prepare(f.binding.workId);
    f.agent.state.current.requestId = "request:replacement";
    await expect(f.actions.submit(p.token, "approve")).rejects.toThrow("WORKBOARD_REQUEST_CHANGED");
    expect(f.agent.state.sends).toHaveLength(0);
  });
  it("expired request is not sent", async () => {
    const f = await fixture(); const p = await f.actions.prepare(f.binding.workId); f.advance();
    await expect(f.actions.submit(p.token, "approve")).rejects.toThrow("WORKBOARD_REQUEST_EXPIRED");
    expect(f.agent.state.sends).toHaveLength(0);
  });
  it("lost ack persists uncertain intent and blocks a replacement request id", async () => {
    const f = await fixture(); const p = await f.actions.prepare(f.binding.workId);
    f.agent.state.lostAck = true; f.agent.state.hideReceipts = true;
    await expect(f.actions.submit(p.token, "approve")).resolves.toMatchObject({ status: "uncertain", receipt: null });
    f.agent.state.current.requestId = "request:replacement";
    await expect(f.actions.prepare(f.binding.workId)).rejects.toThrow("WORKBOARD_DELIVERY_UNCERTAIN");
    await expect(f.actions.submit(p.token, "approve")).resolves.toMatchObject({ status: "uncertain" });
    expect(f.agent.state.sends).toHaveLength(1);
  });
  it("restart/reconnect rereads source receipt without sending again", async () => {
    const f = await fixture(); const p = await f.actions.prepare(f.binding.workId);
    await f.actions.submit(p.token, "reject"); f.restart();
    await expect(f.actions.submit(p.token, "reject")).resolves.toMatchObject({ status: "settled", receipt: { sourceState: "rejected" } });
    expect(f.agent.state.sends).toHaveLength(1);
    expect(f.actions.journal.all()).toHaveLength(1);
  });
  it("lost ACK survives restart, blocks a new id and later reconciles only the old receipt", async () => {
    const f = await fixture(); const p = await f.actions.prepare(f.binding.workId);
    f.agent.state.lostAck = true; f.agent.state.hideReceipts = true;
    const first = await f.actions.submit(p.token, "approve"); f.restart();
    f.agent.state.current.requestId = "replacement-after-restart";
    f.binding.attemptId = "attempt:new";
    await expect(f.actions.prepare(f.binding.workId)).rejects.toThrow("WORKBOARD_DELIVERY_UNCERTAIN");
    expect((await f.actions.submit(p.token, "approve")).intentId).toBe(first.intentId);
    f.agent.state.hideReceipts = false;
    expect(await f.actions.reconcile(first.intentId)).toMatchObject({ status: "settled", receipt: { requestId: p.request.requestId } });
    expect(f.agent.state.sends).toHaveLength(1);
  });
  it("journal commit precedes the observable send and a crash-before-send is never replayed", async () => {
    const f = await fixture(); const p = await f.actions.prepare(f.binding.workId);
    const reserved = f.actions.journal.reserve(p.request, controlValueDigest(p.request), "approve");
    f.restart();
    expect(await f.actions.submit(p.token, "approve")).toMatchObject({ intentId: reserved.intent.intentId, status: "uncertain" });
    expect(f.agent.state.sends).toHaveLength(0);
  });
  it("the endpoint observes the durable intent before processing its effect", async () => {
    const f = await fixture(); const p = await f.actions.prepare(f.binding.workId);
    let beforeSend: unknown;
    f.agent.state.beforeSend = () => { beforeSend = f.actions.journal.all().map(i => [i.status, i.request.requestId]); };
    await f.actions.submit(p.token, "approve");
    expect(beforeSend).toEqual([["uncertain", p.request.requestId]]);
  });
  it.each(["revision", "capabilityVersion", "expiresAt", "payload"] as const)("source %s replacement requires a new dialog", async field => {
    const f = await fixture(); const p = await f.actions.prepare(f.binding.workId);
    if (field === "payload") { f.agent.state.current.payload = { command: "different-scope" }; f.agent.state.current.payloadDigest = controlValueDigest(f.agent.state.current.payload); }
    else f.agent.state.current[field] = field === "expiresAt" ? "2026-09-24T09:16:00.000Z" : "changed";
    await expect(f.actions.submit(p.token, "approve")).rejects.toThrow("WORKBOARD_REQUEST_CHANGED");
    expect(f.agent.state.sends).toHaveLength(0);
  });
  it("source-side conditional compare closes a replacement race after preflight", async () => {
    const f = await fixture(); const p = await f.actions.prepare(f.binding.workId);
    f.agent.state.beforeSend = () => { f.agent.state.current.requestId = "changed-at-send"; };
    expect(await f.actions.submit(p.token, "approve")).toMatchObject({ status: "uncertain", receipt: null });
    expect(f.agent.state.receipts.size).toBe(0);
    expect(f.agent.state.sends).toHaveLength(1);
  });
  it("a contradictory second decision cannot replace the first one", async () => {
    const f = await fixture(); const p = await f.actions.prepare(f.binding.workId);
    await f.actions.submit(p.token, "approve");
    await expect(f.actions.submit(p.token, "reject")).rejects.toThrow("WORKBOARD_DECISION_CONFLICT");
    expect(f.agent.state.sends).toHaveLength(1);
  });
  it("an old receipt is not replaced by a newer uncertain intent on the same work", async () => {
    const f = await fixture(); const old = await f.actions.prepare(f.binding.workId);
    const original = await f.actions.submit(old.token, "approve");
    f.agent.state.current.requestId = "new-request";
    const next = await f.actions.prepare(f.binding.workId); f.agent.state.hideReceipts = true;
    expect((await f.actions.submit(next.token, "reject")).status).toBe("uncertain");
    expect(await f.actions.submit(old.token, "approve")).toEqual(original);
    expect(f.agent.state.sends).toHaveLength(2);
  });
  it("purpose edits preserve approved request bytes and digest", async () => {
    const f = await fixture(); const p = await f.actions.prepare(f.binding.workId);
    await f.actions.submit(p.token, "approve"); const before = f.actions.journal.all();
    f.binding.purposeVersion++;
    await f.actions.submit(p.token, "approve");
    expect(f.actions.journal.all()).toEqual(before);
    expect(f.actions.journal.all()[0]?.request.purposeVersion).toBe(1);
  });
  it("an old-attempt completion claim cannot settle the new action", async () => {
    const f = await fixture(); const p = await f.actions.prepare(f.binding.workId);
    f.agent.state.hideReceipts = true;
    const first = await f.actions.submit(p.token, "approve");
    const receipt = f.agent.state.receipts.get(first.intentId)!;
    receipt.sourceState = "claimed_done";
    receipt.completion = { taskId: p.request.taskId, specVersion: p.request.specVersion, attemptId: "old-attempt",
      acceptanceCriteria: ["fixture result"], evidenceRefs: ["fixture:output"] };
    f.agent.state.hideReceipts = false;
    expect((await f.actions.reconcile(first.intentId)).status).toBe("uncertain");
    receipt.completion.attemptId = p.request.attemptId;
    const reconciled = await f.actions.reconcile(first.intentId);
    expect(reconciled).toMatchObject({ status: "settled", receipt: { sourceState: "claimed_done" } });
    expect(f.agent.state.sends).toHaveLength(1);
  });
  it("unsupported operations and prose requests never dispatch", async () => {
    const f = await fixture(); const p = await f.actions.prepare(f.binding.workId);
    await expect(f.actions.submit(p.token, "stop")).rejects.toThrow("WORKBOARD_ACTION_UNSUPPORTED");
    f.agent.state.current = { summary: "please approve" } as unknown as typeof f.agent.state.current;
    await expect(f.actions.prepare(f.binding.workId)).rejects.toThrow();
    expect(f.agent.state.sends).toHaveLength(0);
  });
  it.each(["sessionId", "attemptId", "specVersion", "purposeVersion"] as const)("%s change invalidates the open dialog", async field => {
    const f = await fixture(); const p = await f.actions.prepare(f.binding.workId);
    if (field === "purposeVersion") f.binding[field] = 2; else f.binding[field] = "changed";
    await expect(f.actions.submit(p.token, "approve")).rejects.toThrow("WORKBOARD_BINDING_CHANGED");
    expect(f.agent.state.sends).toHaveLength(0);
  });
});
