import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt, type ControlCommandRequestInput } from "../../src/control-plane.js";
import { MemoryDeletionSaga } from "../../src/memory-deletion-saga.js";
import { MemoryDeletionStore } from "../../src/memory-deletion-store.js";
import { registerMemoryEffectDelegationKey } from "../../src/memory-effect-delegation.js";
import type { SecondBrainWriteOutcome, SecondBrainWriteRequestAdapter } from "../../src/second-brain-adapter-types.js";
import { SecondBrainEffectService } from "../../src/second-brain-effect-service.js";
import type { SecondBrainMethod, SecondBrainOutcome, SecondBrainTransport } from "../../src/second-brain-transport.js";
import { MemoryTombstoneChain } from "../../src/memory-tombstone-chain.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import {
  noopMemoryBarriers,
  notProvedMemoryObserver,
  unreachableMemoryCompactor,
} from "../fixtures/memory-lifecycle-runtime.js";
import { initialized, localKey } from "../helpers.js";

const request = ((JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  readonly vectors: { readonly forget: { readonly request: MemoryEffectWriteRequestV2 } };
}).vectors.forget.request);
const NOW = new Date("2026-08-31T00:00:01.000Z");
const privateKey = createPrivateKey({ key: Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7),
]), format: "der", type: "pkcs8" });
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

  it("persists forget request identity with suppression and clears the ordered cursor only after acceptance", async () => {
    // Given: an owner-approved deletion using one real saga and a provider that durably accepts once.
    const db = await initialized();
    const root = mkdtempSync(join(tmpdir(), "jarvis-task30-delete-"));
    const calls: MemoryEffectWriteRequestV2[] = [];
    const writer: SecondBrainWriteRequestAdapter = { write(value: unknown): Promise<SecondBrainWriteOutcome> {
      const effect = value as MemoryEffectWriteRequestV2;
      calls.push(effect);
      return Promise.resolve({ schema_version: 2, kind: "accepted", state: "pending",
        request_id: effect.request_id, request_digest: effect.request_digest,
        idempotency_key: effect.idempotency_key, envelope_digest: effect.envelope_digest,
        lane: effect.lane, operation: effect.operation, accepted_at: NOW.toISOString(),
        queue_locator: `pending/${effect.request_id}.v2.json`,
        request_file_digest: `sha256:${"1".repeat(64)}`, replayed: false,
        capability_verified: true, tombstone_sequence: effect.tombstone_high_water.sequence,
        tombstone_set_root: effect.tombstone_high_water.set_root,
        provider_instance_id: effect.provider_instance_id });
    } };
    const transport: SecondBrainTransport = {
      call: async (method: SecondBrainMethod): Promise<SecondBrainOutcome> => method === "sb_generation_status"
        ? { kind: "data", value: { schema_version: 1, provider_instance_id: request.provider_instance_id,
          provider_release_sha: "a".repeat(40), generation_id: target.generation_id,
          generation_manifest_digest: target.generation_manifest_digest,
          vault_head: target.vault_head, vault_tree: target.vault_tree, tombstone_sequence: 0,
          tombstone_set_root: "sha256:7fb694c8abb7c9a4477aa38381c49446493bc4da1c01b50690c1db5b2c20b9d3",
          pointer_health: "healthy", journal_health: "healthy", features: ["memory_effect_write_v2"] } }
        : { kind: "data", value: { schema_version: 1, request_id: calls[0]?.request_id, state: "pending" } },
      restart: async () => undefined, close: async () => undefined, diagnostics: () => [],
    };
    try {
      registerMemoryEffectDelegationKey(db, { key_id: "jarvis:delete", principal_id: "principal:owner",
        public_key_pem: createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString(),
        valid_from: request.created_at, valid_until: request.expires_at }, new Date(request.created_at));
      const provider = new SecondBrainEffectService({ authority: db, transport, writer, clock: () => NOW,
        provider_instance_id: request.provider_instance_id, signing_key_id: "jarvis:delete",
        private_key: privateKey, nonce: () => "delete-status" });
      const saga = new MemoryDeletionSaga({ authority: db, spool_root: join(root, "spool"), writer,
        provider, signing_key_id: "jarvis:delete", private_key: privateKey,
        subject_key: Buffer.alloc(32, 4), clock: () => NOW,
        observer: notProvedMemoryObserver, compactor: unreachableMemoryCompactor,
        barriers: noopMemoryBarriers(db) });
      const action = await saga.prepare({ deletion_id: "memdel:v1:atomic", correlation_id: "corr:atomic",
        provider_instance_id: request.provider_instance_id, targets: request.targets, scope: request.scope,
        erasure_claim: "managed_erasure", external_receipts: [], requested_at: new Date(request.created_at),
        expires_at: new Date(request.expires_at), nonce: "nonce:delete:atomic" });
      const control = new ControlPlane(db); const staged = control.stage(action, NOW);
      const receipt: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1,
        receipt_id: "approval:delete:atomic", request_id: action.request_id, decision: "approve",
        command_digest: staged.command_digest, signer_principal_id: "test-operator",
        authenticated_session_id: "task30", key_id: "decision-test", algorithm: "Ed25519",
        issued_at: NOW.toISOString(), not_before: NOW.toISOString(), expires_at: action.expires_at,
        nonce: "approval-nonce:delete:atomic", max_uses: 1, status: "issued" };
      control.decide(signCommandApproval(receipt, localKey(db)), NOW);

      // When: the approved command is dispatched and provider acceptance returns.
      const row = await saga.dispatch(control.claim(action.request_id, "delete-worker", NOW));

      // Then: one atomic preparation is durable and the cursor advances exactly through sequence one.
      expect(row.state).toBe("reconciling");
      expect(calls).toHaveLength(1);
      expect(db.db.prepare(
        `SELECT state,effective_at,request_id,request_digest,request_tombstone_sequence
         FROM memory_effect_preparations WHERE lane='deletion'`,
      ).get()).toEqual({ state: "approved", effective_at: NOW.toISOString(),
        request_id: calls[0]?.request_id, request_digest: calls[0]?.request_digest,
        request_tombstone_sequence: 1 });
      expect(db.db.prepare(
        "SELECT active_lane_id,accepted_through_sequence FROM memory_effect_dispatch_cursor",
      ).get()).toEqual({ active_lane_id: null, accepted_through_sequence: 1 });
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
