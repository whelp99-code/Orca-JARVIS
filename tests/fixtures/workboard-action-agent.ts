import { createServer } from "node:http";
import { once } from "node:events";
import { canonicalize } from "../../src/canonical.js";
import { controlValueDigest } from "../../src/control-plane-contract.js";
import { bindingSchema, type ActionRequest, type ActionReceipt, type ActionSend } from "../../src/workboard/action-contracts.js";
import { StructuredActions } from "../../src/workboard/adapters/structured-actions.js";

export const ACTION_NOW = new Date("2026-09-24T09:00:00.000Z");
export function actionRequest(): ActionRequest {
  const payload = { command: "fixture-only:resume", agent: "disposable-agent" };
  return { sourceId: "fixture:structured:v1", workId: "work:fixture", taskId: "task:fixture", sessionId: "session:fixture",
    attemptId: "attempt:1", purposeVersion: 1, specVersion: "spec:1", requestId: "request:1", revision: "rev:1",
    capabilityVersion: "conditional-v1", expiresAt: "2026-09-24T09:15:00.000Z", payload, payloadDigest: controlValueDigest(payload),
    target: "disposable fixture agent", scope: "fixture workspace only",
    effects: [{ operation: "approve", label: "시험 작업 승인 후 실행 재개", resumesExecution: true },
      { operation: "reject", label: "시험 요청 거절", resumesExecution: false }] };
}

/** A real local structured endpoint and fixture agent. No timers or live approvals. */
export async function startActionAgent(initial = actionRequest()) {
  const state = { current: structuredClone(initial), sends: [] as ActionSend[], receipts: new Map<string, ActionReceipt>(),
    lostAck: false, hideReceipts: false, now: ACTION_NOW, requestReads: 0, receiptReads: 0, beforeSend: undefined as (() => void) | undefined };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://127.0.0.1").pathname;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.method === "GET" && path.startsWith("/requests/")) { state.requestReads++; json(state.current); return; }
    if (req.method === "GET" && path.startsWith("/receipts/")) {
      state.receiptReads++;
      json(state.hideReceipts ? null : state.receipts.get(decodeURIComponent(path.slice("/receipts/".length))) ?? null); return;
    }
    if (req.method !== "POST" || path !== "/decisions") { json(null, 404); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString()) as ActionSend;
    state.sends.push(input);
    state.beforeSend?.();
    if (canonicalize(input.request) !== canonicalize(state.current) || input.requestDigest !== controlValueDigest(state.current)
      || Date.parse(state.current.expiresAt) <= state.now.getTime() || !state.current.effects.some(e => e.operation === input.operation)) {
      json({ error: "request_changed" }, 409); return;
    }
    if ([...state.receipts.values()].some(r => r.requestId === input.request.requestId)) { json({ error: "already_consumed" }, 409); return; }
    const binding = bindingSchema.parse(Object.fromEntries(Object.entries(input.request).filter(([key]) => key in bindingSchema.shape)));
    const receipt: ActionReceipt = { receiptId: `receipt:${input.intentId}`, intentId: input.intentId, requestId: input.request.requestId,
      requestDigest: input.requestDigest, operation: input.operation, binding,
      sourceState: input.operation === "approve" || input.operation === "resume" || input.operation === "redirect" ? "running" : input.operation === "reject" ? "rejected" : "stopped" };
    state.receipts.set(input.intentId, receipt);
    if (state.lostAck) { res.destroy(); return; }
    json({ acknowledged: true });
  });
  const listening = once(server, "listening", { signal: AbortSignal.timeout(5000) });
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("FIXTURE_BIND_FAILED");
  const endpoint = `http://127.0.0.1:${address.port}/`;
  return { state, endpoint, adapter: new StructuredActions(initial.sourceId, endpoint, initial.effects, "fixture agent"),
    async close() { const closed = once(server, "close", { signal: AbortSignal.timeout(5000) }); server.closeAllConnections(); server.close(); await closed; } };
}
