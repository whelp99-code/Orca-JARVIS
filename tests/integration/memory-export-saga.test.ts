import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt, type ControlCommandRequestInput } from "../../src/control-plane.js";
import { MemoryExportStore } from "../../src/memory-export-store.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import { initialized, localKey } from "../helpers.js";

const request = ((JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  readonly vectors: { readonly export: { readonly request: MemoryEffectWriteRequestV2 } };
}).vectors.export.request);
const NOW = new Date("2026-08-31T00:00:01.000Z");

describe("dedicated export saga", () => {
  it("requires provider proof before availability and enforces hard expiry", async () => {
    const db = await initialized(); const store = new MemoryExportStore(db);
    try {
      const exportId = "memexp:v1:fixture";
      store.request({ export_id: exportId, lane_id: request.lane_id,
        correlation_id: "corr:export:fixture", idempotency_key: "memexp:idem:v1:fixture",
        provider_instance_id: request.provider_instance_id, scope_digest: request.scope_digest,
        target_manifest_digest: request.target_manifest_digest,
        payload_digest: request.delegation.payload_digest,
        tombstone_sequence: request.tombstone_high_water.sequence,
        tombstone_set_root: request.tombstone_high_water.set_root,
        spool_locator: "export.json", spool_digest: `sha256:${"1".repeat(64)}`,
        expires_at: request.expires_at }, request.targets.map(target => target.target_digest), NOW);
      const action: ControlCommandRequestInput = { schema_version: 1, request_id: "control:export:fixture",
        action: "memory.export", action_level: 3, target: { export_id: exportId,
          target_manifest_digest: request.target_manifest_digest, scope_digest: request.scope_digest },
        args: { schema_version: 3, lane: "export", lane_id: request.lane_id,
          provider_instance_id: request.provider_instance_id,
          target_manifest_digest: request.target_manifest_digest, scope_digest: request.scope_digest,
          payload_digest: request.delegation.payload_digest, spool_digest: `sha256:${"1".repeat(64)}`,
          expires_at: request.expires_at }, reversible: false, requested_by: "principal:owner",
        requested_at: request.created_at, expires_at: request.expires_at, nonce: "nonce:export:fixture" };
      const control = new ControlPlane(db); const staged = control.stage(action, NOW);
      const receipt: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1,
        receipt_id: "approval:export:fixture", request_id: action.request_id, decision: "approve",
        command_digest: staged.command_digest, signer_principal_id: "test-operator",
        authenticated_session_id: "task30", key_id: "decision-test", algorithm: "Ed25519",
        issued_at: NOW.toISOString(), not_before: NOW.toISOString(), expires_at: action.expires_at,
        nonce: "approval-nonce:export:fixture", max_uses: 1, status: "issued" };
      control.decide(signCommandApproval(receipt, localKey(db)), NOW);
      const command = control.claim(action.request_id, "export-worker", NOW);
      store.approve(exportId, command, NOW);
      store.queue(exportId, { request_id: request.request_id, request_digest: request.request_digest,
        envelope_digest: request.envelope_digest, provider_idempotency_key: request.idempotency_key,
        delegation_id: request.delegation.delegation_id,
        delegation_digest: request.delegation.delegation_digest, spool_locator: "export.json" }, NOW);
      expect(store.begin(exportId, NOW).state).toBe("writing");
      store.accepted(exportId, { state: "pending" }, `pending/${request.request_id}.json`, NOW);
      expect(() => store.available(exportId, 1, 128, NOW)).toThrow("MEMORY_EXPORT_TRANSITION_INVALID");
      store.proved(exportId, { proof_id: `sbproof:v1:${"2".repeat(64)}`,
        proof_digest: `sha256:${"2".repeat(64)}`, provider_release_sha: "a".repeat(40),
        generation_id: request.expected_prior.generation_id,
        export_manifest_digest: `sha256:${"3".repeat(64)}`,
        surface_manifest_digest: `sha256:${"4".repeat(64)}`, proof_json: "{}" }, NOW);
      expect(store.available(exportId, 1, 128, NOW)).toMatchObject({ state: "available",
        artifact_expires_at: new Date(NOW.getTime() + 86_400_000).toISOString() });
      expect(store.expireAvailable(new Date(NOW.getTime() + 86_400_000 - 1))).toBe(0);
      expect(store.get(exportId)?.state).toBe("available");
      expect(store.expireAvailable(new Date(NOW.getTime() + 86_400_000))).toBe(1);
      expect(store.get(exportId)?.state).toBe("expired");
    } finally { db.close(); }
  });
});
