import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane, signCommandApproval } from "../../src/control-plane.js";
import { ControlPlaneActions } from "../../src/workboard/adapters/control-plane-actions.js";
import { WorkboardActions } from "../../src/workboard/actions.js";
import { preparedSchema, resultSchema } from "../../src/workboard/action-contracts.js";
import { startWorkboardActionDashboard } from "../fixtures/workboard-action-dashboard.js";
import { ACTION_NOW } from "../fixtures/workboard-action-agent.js";

let fixture: Awaited<ReturnType<typeof startWorkboardActionDashboard>> | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
async function start() { fixture = await startWorkboardActionDashboard(); return fixture; }

describe("workboard action route boundary", () => {
  it("rejects missing CSRF before preparing or sending", async () => {
    const f = await start();
    expect((await f.post("prepare", { workId: f.workId }, "invalid")).status).toBe(403);
    expect(f.actions.journal.all()).toHaveLength(0);
    expect(f.agent.state.sends).toHaveLength(0);
  });
  it("approves then rejects distinct disposable requests; repeated click sends neither twice", async () => {
    const f = await start();
    for (const operation of ["approve", "reject"] as const) {
      f.agent.state.current.requestId = `request:${operation}`;
      const preparedResponse = await f.post("prepare", { workId: f.workId });
      expect(preparedResponse.status).toBe(200);
      const prepared = preparedSchema.parse(preparedResponse.body);
      const first = await f.post("submit", { token: prepared.token, operation });
      const again = await f.post("submit", { token: prepared.token, operation });
      expect(first.status).toBe(200); expect(again.body).toEqual(first.body);
      expect(resultSchema.parse(first.body)).toMatchObject({ status: "settled", receipt: { operation } });
    }
    expect(f.agent.state.sends).toHaveLength(2);
    expect(f.actions.journal.all().map(i => i.receipt?.operation)).toEqual(["approve", "reject"]);
  });
  it("GET capabilities is read-only and never contacts the source", async () => {
    const f = await start();
    f.authority.db.pragma("query_only = ON"); f.actions.journal.db.pragma("query_only = ON");
    const response = await fetch(`${f.origin}/api/v1/workboard`);
    expect(response.status).toBe(200);
    const body = await response.json() as { attention: Array<{ work_id: string; action_capability: { available: boolean } }> };
    expect(body.attention.find(c => c.work_id === f.workId)?.action_capability.available).toBe(true);
    expect(f.agent.state.sends).toHaveLength(0);
    expect(f.agent.state.requestReads).toBe(0);
    expect(f.agent.state.receiptReads).toBe(0);
  });
  it("purpose changes in the real projection reject an open dialog without mutating its digest", async () => {
    const f = await start(); const prepared = preparedSchema.parse((await f.post("prepare", { workId: f.workId })).body);
    f.authority.db.prepare("INSERT INTO workboard_purposes VALUES('orca-jarvis',2,'changed','owner','owner-edit')").run();
    const response = await f.post("submit", { token: prepared.token, operation: "approve" });
    expect(response.status).toBe(409); expect(f.agent.state.sends).toHaveLength(0);
    expect(f.actions.journal.prepared(prepared.token)).toEqual(prepared);
  });
  it.each(["approve", "reject"] as const)("JARVIS %s uses a signed Control Plane receipt and does not execute", async operation => {
    const f = await start(); const binding = f.binding(); const control = new ControlPlane(f.authority);
    const staged = control.stage({ schema_version: 1, request_id: `cp:${operation}`, action: "workflow.start", action_level: 2,
      target: { environment: "local", run_id: "fixture-run", loop_id: "agentops-default", correlation_id: binding.taskId, task_id: binding.taskId },
      args: { run_id: "fixture-run", loop_id: "agentops-default", correlation_id: binding.taskId, input: { task_id: binding.taskId, objective: "fixture only" },
        budget: { max_steps: 8, max_attempts_per_node: 2, deadline: "2026-09-24T10:00:00.000Z" } },
      reversible: true, requested_by: "fixture-owner", requested_at: ACTION_NOW.toISOString(),
      expires_at: "2026-09-24T09:15:00.000Z", nonce: `nonce:${operation}` }, ACTION_NOW);
    const adapter = new ControlPlaneActions(f.authority, binding.sourceId, staged.request_id, f.binding, () => ACTION_NOW);
    const service = new WorkboardActions(f.actions.journal, new Map([[f.workId, adapter]]), f.binding, () => ACTION_NOW);
    const p = await service.prepare(f.workId);
    await expect(service.submit(p.token, operation)).rejects.toThrow("WORKBOARD_AUTHORITY_RECEIPT_REQUIRED");
    const receipt = signCommandApproval({ schema_version: 1, receipt_id: `receipt:${operation}`, request_id: staged.request_id,
      decision: operation, command_digest: staged.command_digest, signer_principal_id: "fixture-owner", authenticated_session_id: "fixture-session",
      key_id: "fixture-decision", algorithm: "Ed25519", issued_at: ACTION_NOW.toISOString(), not_before: ACTION_NOW.toISOString(),
      expires_at: staged.expires_at, nonce: `receipt-nonce:${operation}`, max_uses: 1, status: "issued" }, f.decisionKey);
    const result = await service.submit(p.token, operation, receipt);
    expect(result).toMatchObject({ status: "settled", receipt: { operation, receiptId: receipt.receipt_id } });
    expect(control.get(staged.request_id)?.state).toBe(operation === "approve" ? "approved" : "rejected");
    expect(f.authority.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts").get()).toEqual({ n: 1 });
    expect(f.authority.db.prepare("SELECT COUNT(*) AS n FROM control_command_redemptions").get()).toEqual({ n: 0 });
    expect(await service.submit(p.token, operation, receipt)).toEqual(result);
  });
});
