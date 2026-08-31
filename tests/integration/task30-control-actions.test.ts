import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApprovedCommandExecutor, ControlPlane, SecondBrainEffectService, signCommandApproval,
  type CommandApprovalReceipt, type ControlCommandRequestInput, type SecondBrainTransport,
  type SecondBrainWriteRequestAdapter, type SecondBrainWriteOutcome } from "../../src/index.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import { future, initialized, localKey } from "../helpers.js";

const vectors = (JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  vectors: Record<string, Record<string, unknown>>;
}).vectors;
const privateKey = createPrivateKey({ key: Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
]), format: "der", type: "pkcs8" });
function effect(name: "correction" | "forget" | "export"): MemoryEffectWriteRequestV2 {
  return vectors[name]?.request as MemoryEffectWriteRequestV2;
}
class AcceptedWriter implements SecondBrainWriteRequestAdapter {
  readonly calls: unknown[] = [];
  async write(value: unknown): Promise<SecondBrainWriteOutcome> {
    const request = value as MemoryEffectWriteRequestV2; this.calls.push(value);
    return { schema_version: 2, kind: "accepted", state: "pending", request_id: request.request_id,
      request_digest: request.request_digest, idempotency_key: request.idempotency_key,
      envelope_digest: request.envelope_digest, lane: request.lane, operation: request.operation,
      accepted_at: new Date().toISOString(), queue_locator: `pending/${request.request_id}.v2.json`,
      request_file_digest: `sha256:${"1".repeat(64)}`, replayed: false, capability_verified: true,
      tombstone_sequence: request.tombstone_high_water.sequence,
      tombstone_set_root: request.tombstone_high_water.set_root, provider_instance_id: request.provider_instance_id };
  }
}
const transport: SecondBrainTransport = {
  call: async () => ({ kind: "no_data", reason: "empty_result" }), restart: async () => undefined,
  close: async () => undefined, diagnostics: () => [],
};
function command(id: string, request: MemoryEffectWriteRequestV2, level: 3 | 4): ControlCommandRequestInput {
  const now = new Date();
  return { schema_version: 1, request_id: id, action: request.operation === "correct" ? "memory.correct"
    : request.operation === "forget" ? "memory.forget" : "memory.export", action_level: level,
  target: { request_id: request.request_id, provider_instance_id: request.provider_instance_id,
    lane_id: request.lane_id, operation: request.operation }, args: { schema_version: 2, request }, reversible: false,
  requested_by: "principal:owner", requested_at: now.toISOString(), expires_at: future(10), nonce: `nonce:${id}` };
}
function approve(db: Awaited<ReturnType<typeof initialized>>, control: ControlPlane,
  input: ControlCommandRequestInput): void {
  const staged = control.stage(input); const at = new Date().toISOString();
  const receipt: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1, receipt_id: `approval:${input.request_id}`,
    request_id: input.request_id, decision: "approve", command_digest: staged.command_digest,
    signer_principal_id: "test-operator", authenticated_session_id: "task30", key_id: "decision-test",
    algorithm: "Ed25519", issued_at: at, not_before: at, expires_at: input.expires_at,
    nonce: `approval-nonce:${input.request_id}`, max_uses: 1, status: "issued" };
  control.decide(signCommandApproval(receipt, localKey(db)));
}

describe("Task 30 approved memory-effect workflows", () => {
  it("executes correction and export only after level-3 approval", async () => {
    const db = await initialized(); const control = new ControlPlane(db); const writer = new AcceptedWriter();
    const service = new SecondBrainEffectService({ authority: db, transport, writer, clock: () => new Date(),
      provider_instance_id: "provider:fixture", signing_key_id: "jarvis:fixture", private_key: privateKey });
    const executor = new ApprovedCommandExecutor(db, undefined, undefined, {}, () => new Date(), undefined, service);
    try {
      for (const [name, id] of [["correction", "task30-correct"], ["export", "task30-export"]] as const) {
        const input = command(id, effect(name), 3);
        expect(() => control.stage(input)).not.toThrow();
        expect(writer.calls).toHaveLength(name === "correction" ? 0 : 1);
        const staged = control.list().find(item => item.request_id === id); expect(staged?.state).toBe("pending");
        const at = new Date().toISOString();
        const receipt: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1, receipt_id: `approval:${id}`,
          request_id: id, decision: "approve", command_digest: staged?.command_digest ?? "", signer_principal_id: "test-operator",
          authenticated_session_id: "task30", key_id: "decision-test", algorithm: "Ed25519", issued_at: at,
          not_before: at, expires_at: input.expires_at, nonce: `approval-nonce:${id}`, max_uses: 1, status: "issued" };
        control.decide(signCommandApproval(receipt, localKey(db)));
        await expect(executor.execute(id)).resolves.toMatchObject({ state: "completed", action: input.action });
      }
      expect(writer.calls).toHaveLength(2);
    } finally { db.close(); }
  });

  it("rejects under-level forget and denies public rollback even at level 4", async () => {
    const db = await initialized(); const control = new ControlPlane(db); const writer = new AcceptedWriter();
    const service = new SecondBrainEffectService({ authority: db, transport, writer, clock: () => new Date(),
      provider_instance_id: "provider:fixture", signing_key_id: "jarvis:fixture", private_key: privateKey });
    const executor = new ApprovedCommandExecutor(db, undefined, undefined, {}, () => new Date(), undefined, service);
    try {
      const forget = command("task30-forget-low", effect("forget"), 3); approve(db, control, forget);
      await expect(executor.execute(forget.request_id)).resolves.toMatchObject({
        state: "failed", failure_code: "APPROVED_ACTION_LEVEL_TOO_LOW",
      });
      expect(writer.calls).toHaveLength(0);
      const now = new Date();
      const rollback: ControlCommandRequestInput = { schema_version: 1, request_id: "task30-rollback",
        action: "memory.generation.rollback", action_level: 4,
        target: { provider_instance_id: "provider:fixture", generation_id: `sbgen:v1:${"2".repeat(64)}` },
        args: { schema_version: 1, provider_instance_id: "provider:fixture",
          generation_id: `sbgen:v1:${"2".repeat(64)}`, reason: "operator requested" }, reversible: false,
        requested_by: "principal:owner", requested_at: now.toISOString(), expires_at: future(10), nonce: "nonce:rollback" };
      approve(db, control, rollback);
      await expect(executor.execute(rollback.request_id)).resolves.toMatchObject({
        state: "failed", failure_code: "ROLLBACK_REQUIRES_GENERATION_AUTHORITY",
      });
    } finally { db.close(); }
  });
});
