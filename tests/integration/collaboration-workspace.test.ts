import { describe, expect, it } from "vitest";
import { ApprovedCommandExecutor, ControlPlane, signCommandApproval, type CommandApprovalReceipt, type ControlCommandRequestInput } from "../../src/index.js";
import { execute } from "../../src/cli.js";
import { future, initialized, localKey } from "../helpers.js";

const obsoleteRequest = (): ControlCommandRequestInput => {
  const requestedAt = new Date().toISOString();
  return { schema_version: 1, request_id: "request:obsolete-room", action: "collaboration.room.create", action_level: 3, target: { task_id: "task:obsolete" }, args: { room: { room_id: "room:obsolete" } }, reversible: true, requested_by: "test-operator", requested_at: requestedAt, expires_at: future(10), nonce: "nonce:obsolete-room" };
};

describe("retired collaboration workspace", () => {
  it("preserves migration 025 history while fail-closing all former room and Buzz mutation paths", async () => {
    const db = await initialized(); const deprecation = db.db.prepare("SELECT replacement FROM feature_deprecations WHERE feature_id='collaboration-workspace'").get();
    expect(deprecation).toEqual({ replacement: "task-timeline" });
    expect(() => db.db.prepare("INSERT INTO collaboration_identities(identity_id,identity_type,display_name,public_key_pem,key_fingerprint,created_request_id,created_at) VALUES('agent:old','agent','Old Agent','pem','fingerprint','missing','2026-08-12T00:00:00.000Z')").run()).toThrow("COLLABORATION_DEPRECATED_USE_TASK_TIMELINE");

    const control = new ControlPlane(db); const executor = new ApprovedCommandExecutor(db); const input = obsoleteRequest(); const staged = control.stage(input); const issuedAt = new Date().toISOString();
    const payload: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1, receipt_id: "approval:obsolete-room", request_id: input.request_id, decision: "approve", command_digest: staged.command_digest, signer_principal_id: "test-operator", authenticated_session_id: "action-hub", key_id: "decision-test", algorithm: "Ed25519", issued_at: issuedAt, not_before: issuedAt, expires_at: input.expires_at, nonce: "receipt:obsolete-room", max_uses: 1, status: "issued" };
    control.decide(signCommandApproval(payload, localKey(db))); const result = await executor.execute(input.request_id); expect(result).toMatchObject({ state: "failed", failure_code: "APPROVED_ACTION_UNKNOWN" });
    expect((db.db.prepare("SELECT COUNT(*) AS count FROM collaboration_rooms").get() as { count: number }).count).toBe(0);
    const filename = db.filename; db.close();
    await expect(execute(["collaboration", "rooms", "--db", filename])).rejects.toMatchObject({ code: "UNKNOWN_COMMAND" });
  });
});
