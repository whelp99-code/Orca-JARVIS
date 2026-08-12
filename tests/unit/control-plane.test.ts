import { describe, expect, it } from "vitest";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt, type ControlCommandRequestInput } from "../../src/index.js";
import { future, initialized, localKey } from "../helpers.js";

const request = (id: string): ControlCommandRequestInput => ({ schema_version: 1, request_id: id, action: "runbook.execute", action_level: 3, target: { environment: "local", runbook_id: "daemon-dead" }, args: { runbook_id: "daemon-dead", args: { dry_run: false } }, reversible: true, requested_by: "operator", requested_at: new Date().toISOString(), expires_at: future(10), nonce: `nonce-${id}` });
const requestAt = (id: string, now: Date, lifetimeMs = 10 * 60_000): ControlCommandRequestInput => ({ ...request(id), requested_at: now.toISOString(), expires_at: new Date(now.getTime() + lifetimeMs).toISOString() });

function approval(db: Awaited<ReturnType<typeof initialized>>, staged: ReturnType<ControlPlane["stage"]>, overrides: Partial<Omit<CommandApprovalReceipt, "signature">> = {}): CommandApprovalReceipt {
  const now = new Date().toISOString();
  return signCommandApproval({ schema_version: 1, receipt_id: `approve-${staged.request_id}`, request_id: staged.request_id, decision: "approve", command_digest: staged.command_digest, signer_principal_id: "test-operator", authenticated_session_id: "action-hub-session", key_id: "decision-test", algorithm: "Ed25519", issued_at: now, not_before: now, expires_at: staged.expires_at, nonce: `approval-${staged.request_id}`, max_uses: 1, status: "issued", ...overrides }, localKey(db));
}

describe("approval-only control plane", () => {
  it("requires a fresh one-use human receipt before a command can be claimed", async () => {
    const db = await initialized(); const control = new ControlPlane(db); const staged = control.stage(request("cmd-1"));
    expect(() => control.claim(staged.request_id, "worker")).toThrow("CONTROL_APPROVAL_REQUIRED");
    control.decide(approval(db, staged));
    const claimed = control.claim(staged.request_id, "worker");
    expect(claimed).toMatchObject({ action: "runbook.execute", action_level: 3, fence: 1 });
    expect(() => control.claim(staged.request_id, "worker-2")).toThrow("CONTROL_APPROVAL_REQUIRED");
    control.settle(staged.request_id, claimed.fence, { state: "completed", effect_type: "runbook.result", payload: { restarted: true } });
    expect(control.list()[0]).toMatchObject({ state: "completed" });
    expect((db.db.prepare("SELECT COUNT(*) AS count FROM control_command_redemptions").get() as { count: number }).count).toBe(1);
    expect((db.db.prepare("SELECT COUNT(*) AS count FROM control_events").get() as { count: number }).count).toBe(4);
    db.close();
  });

  it("rejects mismatched, expired, replayed, and stale-fence approvals", async () => {
    const db = await initialized(); const control = new ControlPlane(db); const staged = control.stage(request("cmd-2"));
    expect(() => control.decide(approval(db, staged, { command_digest: "sha256:wrong" }))).toThrow("CONTROL_APPROVAL_NOT_APPLICABLE");
    const old = new Date(Date.now() - 20 * 60_000).toISOString(); const expired = signCommandApproval({ schema_version: 1, receipt_id: "expired-cmd-2", request_id: staged.request_id, decision: "approve", command_digest: staged.command_digest, signer_principal_id: "test-operator", authenticated_session_id: "action-hub-session", key_id: "decision-test", algorithm: "Ed25519", issued_at: old, not_before: old, expires_at: new Date(Date.now() - 10 * 60_000).toISOString(), nonce: "expired-approval-cmd-2", max_uses: 1, status: "issued" }, localKey(db));
    expect(() => control.decide(expired)).toThrow("CONTROL_APPROVAL_INVALID");
    control.decide(approval(db, staged)); const claimed = control.claim(staged.request_id, "worker");
    expect(() => control.settle(staged.request_id, claimed.fence + 1, { state: "failed", effect_type: "runbook.result", payload: {} })).toThrow("CONTROL_STALE_FENCE");
    db.close();
  });

  it("requires reversible to be an exact boolean", async () => {
    const db = await initialized(); const control = new ControlPlane(db);
    try {
      const malformed = { ...request("non-boolean-reversible"), reversible: "false" } as unknown as ControlCommandRequestInput;
      expect(() => control.stage(malformed)).toThrow("CONTROL_COMMAND_INVALID");
    } finally { db.close(); }
  });

  it("rejects a command whose staging authority is already expired", async () => {
    const db = await initialized(); const control = new ControlPlane(db);
    try {
      const now = new Date("2026-08-12T14:00:00.000Z");
      const stage = control.stage.bind(control) as (input: ControlCommandRequestInput, at?: Date) => ReturnType<ControlPlane["stage"]>;
      expect(() => stage(requestAt("expired-at-stage", new Date(now.getTime() - 120_000), 60_000), now)).toThrow("CONTROL_COMMAND_INVALID");
    } finally { db.close(); }
  });

  it("rejects unknown actions at staging", async () => {
    const db = await initialized(); const control = new ControlPlane(db);
    try {
      expect(() => control.stage({ ...request("unknown-action"), action: "database.drop_everything" })).toThrow("CONTROL_ACTION_UNKNOWN");
    } finally { db.close(); }
  });

  it("rejects an action whose target is outside its local authority", async () => {
    const db = await initialized(); const control = new ControlPlane(db);
    try {
      expect(() => control.stage({ ...request("target-mismatch"), action: "database.backup", action_level: 2, target: { environment: "remote", host: "other-host" }, args: { destination: "snapshot.sqlite" } })).toThrow("CONTROL_TARGET_MISMATCH");
    } finally { db.close(); }
  });

  it("caps a claim lease at both command and approval authority expiry", async () => {
    const db = await initialized(); const control = new ControlPlane(db); const now = new Date("2026-08-12T12:00:00.000Z");
    try {
      const staged = control.stage(requestAt("lease-cap", now, 2 * 60_000), now);
      const issued = new Date(now.getTime() + 1_000).toISOString();
      control.decide(approval(db, staged, { issued_at: issued, not_before: issued, expires_at: staged.expires_at }), new Date(issued));
      const claimed = control.claim(staged.request_id, "worker", new Date(now.getTime() + 2_000), 15 * 60_000);
      expect(Date.parse(claimed.lease_expires_at)).toBeLessThanOrEqual(Date.parse(staged.expires_at));
    } finally { db.close(); }
  });

  it("skips approved queue entries whose authority has gone stale", async () => {
    const db = await initialized(); const control = new ControlPlane(db); const now = new Date("2026-08-12T13:00:00.000Z");
    try {
      const staged = control.stage(requestAt("stale-approved", now, 60_000), now);
      const issued = new Date(now.getTime() + 1_000).toISOString();
      control.decide(approval(db, staged, { issued_at: issued, not_before: issued, expires_at: staged.expires_at }), new Date(issued));
      const queue = control as unknown as { nextApproved(at?: Date): string | null };
      expect(queue.nextApproved(new Date(now.getTime() + 60_001))).toBeNull();
    } finally { db.close(); }
  });

  it("honors authority revocation before redemption", async () => {
    const db = await initialized(); const control = new ControlPlane(db);
    try {
      const staged = control.stage(request("revoked-before-claim")); const receipt = approval(db, staged);
      control.decide(receipt); db.revokeAuthority(receipt.receipt_id, "operator withdrew approval");
      expect(() => control.claim(staged.request_id, "worker")).toThrow("CONTROL_APPROVAL_REVOKED");
    } finally { db.close(); }
  });

  it("exposes cancellation that revokes an unredeemed approval", async () => {
    const db = await initialized(); const control = new ControlPlane(db);
    try {
      const staged = control.stage(request("cancel-approved")); control.decide(approval(db, staged));
      const cancelledAt = new Date("2026-08-12T14:00:00.000Z");
      const cancellable = control as unknown as { cancel?: (input: { request_id: string; reason: string; revoked_by: string; revoked_at: string }, now?: Date) => void };
      expect(typeof cancellable.cancel).toBe("function");
      cancellable.cancel?.({ request_id: staged.request_id, reason: "operator cancelled", revoked_by: "test-operator", revoked_at: cancelledAt.toISOString() }, cancelledAt);
      expect(control.list().find(item => item.request_id === staged.request_id)).toMatchObject({ state: "cancelled" });
      expect(() => control.claim(staged.request_id, "worker")).toThrow("CONTROL_APPROVAL_REQUIRED");
    } finally { db.close(); }
  });

  it("rejects settlement after the claim lease has expired", async () => {
    const db = await initialized(); const control = new ControlPlane(db); const now = new Date("2026-08-12T14:00:00.000Z");
    try {
      const staged = control.stage(requestAt("expired-settlement", now), now); const issued = new Date(now.getTime() + 1_000).toISOString();
      control.decide(approval(db, staged, { issued_at: issued, not_before: issued, expires_at: staged.expires_at }), new Date(issued));
      const claimedAt = new Date(now.getTime() + 2_000); const claimed = control.claim(staged.request_id, "worker", claimedAt, 1_000);
      expect(() => control.settle(staged.request_id, claimed.fence, { state: "completed", effect_type: "runbook.result", payload: {} }, new Date(claimedAt.getTime() + 1_001))).toThrow("CONTROL_STALE_FENCE");
      expect((db.db.prepare("SELECT COUNT(*) AS count FROM control_command_effects WHERE request_id=?").get(staged.request_id) as { count: number }).count).toBe(0);
    } finally { db.close(); }
  });
});
