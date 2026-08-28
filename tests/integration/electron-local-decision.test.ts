import { describe, expect, it } from "vitest";
import { ControlPlane, signCommandApproval, type ControlCommandRequestInput } from "../../src/control-plane.js";
import { DashboardReadModel } from "../../src/dashboard/read-model.js";
import { initialized, localKey } from "../helpers.js";

const NOW = new Date("2026-08-28T12:00:00.000Z");

function request(): ControlCommandRequestInput {
  return {
    schema_version: 1,
    request_id: "request:electron-settlement",
    action: "workflow.start",
    action_level: 2,
    target: {
      environment: "local",
      run_id: "run:electron",
      loop_id: "agentops-default",
      correlation_id: "task:electron",
      task_id: "task:electron",
    },
    args: {
      run_id: "run:electron",
      loop_id: "agentops-default",
      correlation_id: "task:electron",
      input: { task_id: "task:electron" },
      budget: { max_steps: 8 },
    },
    reversible: true,
    requested_by: "electron-client",
    requested_at: NOW.toISOString(),
    expires_at: "2026-08-28T12:15:00.000Z",
    nonce: "nonce:electron-settlement",
  };
}

describe("Electron settlement projection", () => {
  it("removes settled controls and prevents a duplicate effect", async () => {
    // Given
    const db = await initialized();
    const control = new ControlPlane(db);
    const staged = control.stage(request(), NOW);
    const model = new DashboardReadModel(db);
    const receipt = signCommandApproval({
      schema_version: 1,
      receipt_id: "receipt:electron-settlement",
      request_id: staged.request_id,
      decision: "approve",
      command_digest: staged.command_digest,
      signer_principal_id: "test-operator",
      authenticated_session_id: "session:electron-settlement",
      key_id: "decision-test",
      algorithm: "Ed25519",
      issued_at: NOW.toISOString(),
      not_before: NOW.toISOString(),
      expires_at: staged.expires_at,
      nonce: "receipt-nonce:electron-settlement",
      max_uses: 1,
      status: "issued",
    }, localKey(db));
    expect(model.listControlRequests().items).toHaveLength(1);
    control.decide(receipt, NOW);
    const claimed = control.claim(staged.request_id, "linux-approved-executor", NOW);

    // When
    control.settle(staged.request_id, claimed.fence, {
      state: "completed",
      effect_type: "workflow.started",
      payload: { run_id: "run:electron" },
    }, NOW);

    // Then
    expect(model.listControlRequests().items).toEqual([]);
    expect(() => control.settle(staged.request_id, claimed.fence, {
      state: "completed",
      effect_type: "workflow.started",
      payload: { run_id: "run:electron" },
    }, NOW)).toThrowError(expect.objectContaining({ code: "CONTROL_STALE_FENCE" }));
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM control_command_effects WHERE request_id=?")
      .get(staged.request_id)).toEqual({ count: 1 });
    db.close();
  });
});
