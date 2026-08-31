import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt, type ControlCommandRequestInput } from "../../src/control-plane.js";
import { MemoryDeletionStore } from "../../src/memory-deletion-store.js";
import { MemoryTombstoneChain } from "../../src/memory-tombstone-chain.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import { initialized, localKey } from "../helpers.js";

const request = ((JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  readonly vectors: { readonly forget: { readonly request: MemoryEffectWriteRequestV2 } };
}).vectors.forget.request);
const NOW = new Date("2026-08-31T00:00:01.000Z");
function fixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("MEMORY_FIXTURE_INVALID");
  return value;
}
const target = fixture(request.targets[0]);
const tombstoneDelta = fixture(request.tombstone_chain_delta[0]);

describe("dedicated irreversible deletion saga", () => {
  it("keeps permanent suppression while post-dispatch uncertainty reconciles", async () => {
    const db = await initialized(); const store = new MemoryDeletionStore(db);
    try {
      const deletionId = "memdel:v1:fixture";
      store.request({ deletion_id: deletionId, correlation_id: "corr:delete:fixture",
        idempotency_key: "memdel:idem:v1:fixture", keyed_subject_digest: target.subject_digest,
        scope_digest: request.scope_digest, target_manifest_digest: request.target_manifest_digest,
        payload_digest: request.delegation.payload_digest, spool_locator: "delete.json",
        spool_digest: `sha256:${"1".repeat(64)}`, expires_at: request.expires_at }, NOW);
      const action: ControlCommandRequestInput = { schema_version: 1, request_id: "control:delete:fixture",
        action: "memory.delete", action_level: 3, target: { deletion_id: deletionId,
          target_manifest_digest: request.target_manifest_digest, scope_digest: request.scope_digest },
        args: { schema_version: 3, lane: "deletion", lane_id: request.lane_id,
          provider_instance_id: request.provider_instance_id,
          target_manifest_digest: request.target_manifest_digest, scope_digest: request.scope_digest,
          payload_digest: request.delegation.payload_digest, spool_digest: `sha256:${"1".repeat(64)}`,
          expires_at: request.expires_at }, reversible: false, requested_by: "principal:owner",
        requested_at: request.created_at, expires_at: request.expires_at, nonce: "nonce:delete:fixture" };
      const control = new ControlPlane(db); const staged = control.stage(action, NOW);
      const receipt: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1,
        receipt_id: "approval:delete:fixture", request_id: action.request_id, decision: "approve",
        command_digest: staged.command_digest, signer_principal_id: "test-operator",
        authenticated_session_id: "task30", key_id: "decision-test", algorithm: "Ed25519",
        issued_at: NOW.toISOString(), not_before: NOW.toISOString(), expires_at: action.expires_at,
        nonce: "approval-nonce:delete:fixture", max_uses: 1, status: "issued" };
      control.decide(signCommandApproval(receipt, localKey(db)), NOW);
      const command = control.claim(action.request_id, "delete-worker", NOW);
      store.approve(deletionId, { lane_id: request.lane_id,
        provider_instance_id: request.provider_instance_id, control_request_id: command.request_id,
        control_receipt_id: command.receipt_id, control_command_digest: command.command_digest }, NOW);
      const chain = new MemoryTombstoneChain(db, Buffer.alloc(32, 4));
      const tombstone = chain.append({ operation: "forget", lane_id: request.lane_id,
        targets: request.targets, target_manifest_digest: request.target_manifest_digest,
        scope_digest: request.scope_digest,
        authority_receipt_digest: tombstoneDelta.authority_receipt_digest,
        payload_digest: request.delegation.payload_digest, effective_at: NOW.toISOString() });
      store.suppress(deletionId, tombstone.entry.sequence, tombstone.entry.set_root, NOW);
      store.queue(deletionId, { request_id: request.request_id, request_digest: request.request_digest,
        envelope_digest: request.envelope_digest, provider_idempotency_key: request.idempotency_key,
        delegation_id: request.delegation.delegation_id,
        delegation_digest: request.delegation.delegation_digest, spool_locator: "delete.json" }, NOW);
      expect(store.begin(deletionId, NOW).state).toBe("applying");
      store.uncertain(deletionId, "SECOND_BRAIN_WRITE_INTERRUPTED", NOW);
      expect(store.get(deletionId)).toMatchObject({ state: "reconciling",
        tombstone_sequence: tombstone.entry.sequence, dispatch_fence: 1 });
      expect(() => store.settle(deletionId, `sha256:${"f".repeat(64)}`, NOW))
        .toThrow("MEMORY_DELETION_TRANSITION_INVALID");
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_suppressions").get())
        .toEqual({ count: 1 });
    } finally { db.close(); }
  });
});
