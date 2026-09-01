import { describe, expect, it } from "vitest";
import { ApprovedCommandExecutor } from "../../src/approved-executor.js";
import {
  ControlPlane,
  signCommandApproval,
  type CommandApprovalReceipt,
  type ControlCommandRequestInput,
} from "../../src/control-plane.js";
import type { ClaimedControlCommand } from "../../src/control-plane.js";
import { initialized, localKey } from "../helpers.js";

const NOW = new Date("2026-08-31T00:00:00.000Z");
const EXPIRES = "2026-08-31T00:10:00.000Z";
const digest = `sha256:${"1".repeat(64)}`;

function command(action: "memory.outbox.dispatch" | "memory.delete" | "memory.export"): ControlCommandRequestInput {
  const lane = action === "memory.outbox.dispatch" ? "correction" : action === "memory.delete" ? "deletion" : "export";
  const lanePrefix = lane === "correction" ? "memcorr" : lane === "deletion" ? "memdel" : "memexp";
  const requestId = `control:${lane}`;
  return { schema_version: 1, request_id: requestId, action, action_level: 3,
    target: lane === "correction" ? { candidate_id: "candidate:1", candidate_digest: digest,
      classification_digest: digest } : lane === "deletion" ? { deletion_id: "deletion:1",
      target_manifest_digest: digest, scope_digest: digest } : { export_id: "export:1",
      target_manifest_digest: digest, scope_digest: digest },
    args: { schema_version: 3, lane, lane_id: `${lanePrefix}:req:v1:${"2".repeat(64)}`,
      provider_instance_id: "provider:test", target_manifest_digest: digest,
      scope_digest: digest, payload_digest: digest, spool_digest: digest, expires_at: EXPIRES },
    reversible: false, requested_by: "principal:owner", requested_at: NOW.toISOString(),
    expires_at: EXPIRES, nonce: `nonce:${lane}` };
}

function approve(control: ControlPlane, input: ControlCommandRequestInput,
  key: ReturnType<typeof localKey>): void {
  const staged = control.stage(input, NOW);
  const receipt: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1,
    receipt_id: `approval:${input.request_id}`, request_id: input.request_id, decision: "approve",
    command_digest: staged.command_digest, signer_principal_id: "test-operator",
    authenticated_session_id: "task30", key_id: "decision-test", algorithm: "Ed25519",
    issued_at: NOW.toISOString(), not_before: NOW.toISOString(), expires_at: EXPIRES,
    nonce: `approval:${input.request_id}`, max_uses: 1, status: "issued" };
  control.decide(signCommandApproval(receipt, key), NOW);
}

describe("single memory lifecycle executor boundary", () => {
  it("delegates correction, deletion, and export exactly once to one service", async () => {
    // Given: three independently approved Task 30 commands and one shared lifecycle service.
    const db = await initialized();
    try {
      const control = new ControlPlane(db);
      const commands = [command("memory.outbox.dispatch"), command("memory.delete"),
        command("memory.export")] as const;
      for (const input of commands) approve(control, input, localKey(db));
      const observed: string[] = [];
      const lifecycle = { async execute(claimed: ClaimedControlCommand): Promise<{
        readonly kind: "correction" | "deletion" | "export";
        readonly id: string; readonly state: "settled" | "available";
      }> {
        observed.push(claimed.action);
        switch (claimed.action) {
          case "memory.outbox.dispatch": return { kind: "correction", id: "correction:1", state: "settled" };
          case "memory.delete": return { kind: "deletion", id: "deletion:1", state: "settled" };
          case "memory.export": return { kind: "export", id: "export:1", state: "available" };
          default: throw new Error("unexpected lifecycle action");
        }
      } };
      const created: unknown = Reflect.construct(ApprovedCommandExecutor,
        [db, undefined, undefined, {}, () => NOW, undefined, undefined, lifecycle]);
      if (!(created instanceof ApprovedCommandExecutor)) throw new Error("MEMORY_EXECUTOR_FIXTURE_INVALID");

      // When: each command executes through the public approved executor.
      const results = [];
      for (const input of commands) results.push(await created.execute(input.request_id, "worker", NOW));

      // Then: one service receives one call per distinct lane and every command completes.
      expect(observed).toEqual(["memory.outbox.dispatch", "memory.delete", "memory.export"]);
      expect(results.map(result => result.state)).toEqual(["completed", "completed", "completed"]);
    } finally { db.close(); }
  });
});
