import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { AuthorityDb, createSecondBrainWriteRequestAdapter, SecondBrainEffectService, type SecondBrainMethod,
  type SecondBrainOutcome, type SecondBrainTransport } from "../../src/index.js";
import { hasMemoryEffectWriteAuthority, prepareMemoryEffectDispatch, recordMemoryEffectAccepted,
  recordMemoryEffectDispatchFailure, recordMemoryEffectProviderStatus, registerMemoryEffectDelegationKey, registerMemoryProviderProofKey,
  revokeMemoryEffectDelegation } from "../../src/second-brain-effect-authority.js";
import { memoryEffectDigest, parseMemoryEffectWriteRequest, type MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import { tempDb } from "../helpers.js";

const vectors = (JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  vectors: Record<string, Record<string, unknown>>;
}).vectors;
const privateKey = createPrivateKey({ key: Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
]), format: "der", type: "pkcs8" });
const publicPem = createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString();
const providerPrivateKey = createPrivateKey({ key: Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(Array.from({ length: 32 }, (_, index) => index + 32)),
]), format: "der", type: "pkcs8" });
const providerPublicPem = createPublicKey(providerPrivateKey).export({ format: "pem", type: "spki" }).toString();
const now = new Date("2026-08-31T00:00:01.000Z");
function vector(name: "correction" | "forget"): MemoryEffectWriteRequestV2 {
  const value = vectors[name]?.request;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("vector missing");
  return value as MemoryEffectWriteRequestV2;
}
function controlAuthority(db: AuthorityDb, request: MemoryEffectWriteRequestV2): void {
  const requestId = `control:${request.operation}`; const receiptId = `receipt:${request.operation}`;
  const args = canonicalize({ schema_version: 2, request });
  const target = canonicalize({ request_id: request.request_id, provider_instance_id: request.provider_instance_id,
    lane_id: request.lane_id, operation: request.operation });
  const action = request.operation === "correct" ? "memory.correct" : "memory.forget";
  db.db.prepare(
    `INSERT INTO control_command_requests(
      request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,
      expires_at,nonce,state,lease_owner,lease_fence,lease_expires_at,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(requestId, action, request.operation === "forget" ? 4 : 3, target, args, "sha256:control", 0,
    "principal:owner", "2026-08-31T00:00:00.000Z", "2026-08-31T00:10:00.000Z", `nonce:${request.operation}`,
    "claimed", "worker", 1, "2026-08-31T00:05:00.000Z", "2026-08-31T00:00:00.000Z");
  db.db.prepare(
    `INSERT INTO control_command_receipts(
      receipt_id,request_id,decision,command_digest,signer_principal_id,authenticated_session_id,key_id,payload_json,
      signature,issued_at,expires_at,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(receiptId, requestId, "approve", "sha256:control", "principal:owner", "session", "control-key", "{}", "sig",
    "2026-08-31T00:00:00.000Z", "2026-08-31T00:10:00.000Z", "2026-08-31T00:00:00.000Z");
  db.db.prepare("INSERT INTO control_command_redemptions(receipt_id,request_id,lease_fence,redeemed_at) VALUES(?,?,?,?)")
    .run(receiptId, requestId, 1, "2026-08-31T00:00:00.000Z");
}

describe("Task 30 memory-effect authority migrations", () => {
  it("publishes immutable request, delegation, progress, erasure, target, and watermark ledgers", async () => {
    const db = new AuthorityDb(tempDb());
    try {
      await db.migrate();
      const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name);
      expect(tables).toEqual(expect.arrayContaining([
        "memory_effect_requests", "memory_effect_delegation_keys", "memory_external_erasure_keys",
        "memory_effect_delegations", "memory_effect_delegation_revocations", "memory_effect_delegation_uses",
        "memory_effect_progress", "memory_provider_proof_keys", "memory_erasure_ledger",
        "memory_resolved_targets", "memory_effect_request_targets", "memory_tombstone_watermarks",
      ]));
      for (const slot of ["040_memory_effect_requests.sql", "041_memory_effect_delegations.sql",
        "042_memory_effect_progress.sql", "043_memory_erasure_ledger.sql", "044_memory_targets_tombstones.sql"]) {
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id=?").get(slot)).toEqual({ n: 1 });
      }
      const immutable = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>).map(row => row.name);
      expect(immutable).toEqual(expect.arrayContaining([
        "memory_effect_requests_identity_immutable", "memory_effect_delegations_immutable_update",
        "memory_effect_progress_immutable_update", "memory_erasure_ledger_immutable_update",
        "memory_resolved_targets_immutable_update", "memory_tombstone_watermarks_immutable_update",
      ]));
    } finally { db.close(); }
  });

  it("journals provider acceptance before exact replay without spending a second delegation", async () => {
    const db = new AuthorityDb(tempDb());
    try {
      await db.migrate();
      registerMemoryEffectDelegationKey(db, { key_id: "jarvis:fixture", principal_id: "principal:owner",
        public_key_pem: publicPem, valid_from: "2026-08-31T00:00:00.000Z", valid_until: "2026-09-01T00:00:00.000Z" },
      new Date("2026-08-31T00:00:00.000Z"));
      const request = vector("correction"); controlAuthority(db, request); let calls = 0;
      const transport: SecondBrainTransport = {
        call: async (method: SecondBrainMethod): Promise<SecondBrainOutcome> => {
          expect(method).toBe("sb_write_request"); calls += 1;
          return { kind: "data", value: { schema_version: 2, kind: "accepted", state: "pending",
            request_id: request.request_id, request_digest: request.request_digest,
            idempotency_key: request.idempotency_key, envelope_digest: request.envelope_digest,
            lane: request.lane, operation: request.operation, accepted_at: "2026-08-31T00:00:01.000Z",
            queue_locator: `pending/${request.request_id}.v2.json`, request_file_digest: `sha256:${"1".repeat(64)}`,
            replayed: calls > 1, capability_verified: true, tombstone_sequence: request.tombstone_high_water.sequence,
            tombstone_set_root: request.tombstone_high_water.set_root, provider_instance_id: request.provider_instance_id } };
        }, restart: async () => undefined, close: async () => undefined, diagnostics: () => [],
      };
      const adapter = createSecondBrainWriteRequestAdapter(transport, db, () => now);
      await expect(adapter.write(request)).resolves.toMatchObject({ kind: "accepted", schema_version: 2, replayed: false });
      await expect(adapter.write(request)).resolves.toMatchObject({ kind: "accepted", schema_version: 2, replayed: true });
      expect(calls).toBe(2);
      expect(db.db.prepare("SELECT state FROM memory_effect_requests WHERE request_id=?").get(request.request_id))
        .toEqual({ state: "accepted" });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM memory_effect_delegation_uses").get()).toEqual({ n: 1 });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM memory_effect_progress").get()).toEqual({ n: 1 });
      expect(db.db.prepare("SELECT sequence,set_root FROM memory_tombstone_watermarks").get())
        .toEqual(request.tombstone_high_water);
    } finally { db.close(); }
  });

  it("recovers uncertain acceptance with the request candidate high-water fence", async () => {
    const db = new AuthorityDb(tempDb());
    try {
      await db.migrate();
      registerMemoryEffectDelegationKey(db, { key_id: "jarvis:fixture", principal_id: "principal:owner",
        public_key_pem: publicPem, valid_from: "2026-08-31T00:00:00.000Z", valid_until: "2026-09-01T00:00:00.000Z" },
      new Date("2026-08-31T00:00:00.000Z"));
      const request = vector("forget"); controlAuthority(db, request); prepareMemoryEffectDispatch(db, request, now);
      recordMemoryEffectDispatchFailure(db, request.request_id, "uncertain", "SECOND_BRAIN_WRITE_TIMEOUT", now);
      let observedFence: unknown;
      const transport: SecondBrainTransport = {
        call: async (_method: SecondBrainMethod, arguments_: Readonly<Record<string, unknown>>) => {
          observedFence = (arguments_.read_fence as Record<string, unknown> | undefined)?.tombstone_sequence;
          return { kind: "data", value: { schema_version: 1, request_id: request.request_id,
            request_digest: request.request_digest, envelope_digest: request.envelope_digest,
            idempotency_key: request.idempotency_key, lane_id: request.lane_id, operation: request.operation,
            state: "pending", phase: null, fence: 0, tombstone_sequence: request.tombstone_high_water.sequence,
            tombstone_set_root: request.tombstone_high_water.set_root, status_digest: null } };
        }, restart: async () => undefined, close: async () => undefined, diagnostics: () => [],
      };
      const service = new SecondBrainEffectService({ authority: db, transport,
        writer: { write: async () => ({ kind: "uncertain", code: "unused" }) },
        clock: () => now, provider_instance_id: "provider:fixture", signing_key_id: "jarvis:fixture",
        private_key: privateKey, nonce: () => "uncertain" });
      await expect(service.requestStatus(request.request_id)).resolves.toMatchObject({ kind: "data", value: { state: "pending" } });
      expect(observedFence).toBe(2);
      expect(db.db.prepare("SELECT state FROM memory_effect_requests WHERE request_id=?").get(request.request_id))
        .toEqual({ state: "accepted" });
      expect(db.db.prepare("SELECT sequence,set_root FROM memory_tombstone_watermarks").get())
        .toEqual(request.tombstone_high_water);
    } finally { db.close(); }
  });

  it("verifies provider proof before completing forget and recording physical absence", async () => {
    const db = new AuthorityDb(tempDb());
    try {
      await db.migrate();
      registerMemoryEffectDelegationKey(db, { key_id: "jarvis:fixture", principal_id: "principal:owner",
        public_key_pem: publicPem, valid_from: "2026-08-31T00:00:00.000Z", valid_until: "2026-09-01T00:00:00.000Z" },
      new Date("2026-08-31T00:00:00.000Z"));
      registerMemoryProviderProofKey(db, { key_id: "provider-proof:fixture", provider_instance_id: "provider:fixture",
        provider_release_sha: "a".repeat(40), public_key_pem: providerPublicPem,
        valid_from: "2026-08-31T00:00:00.000Z", valid_until: "2026-09-01T00:00:00.000Z" },
      new Date("2026-08-31T00:00:00.000Z"));
      const request = vector("forget"); controlAuthority(db, request); prepareMemoryEffectDispatch(db, request, now);
      recordMemoryEffectAccepted(db, request, { schema_version: 2, kind: "accepted", state: "pending",
        request_id: request.request_id, request_digest: request.request_digest, idempotency_key: request.idempotency_key,
        envelope_digest: request.envelope_digest, lane: request.lane, operation: request.operation,
        accepted_at: "2026-08-31T00:00:01.000Z", queue_locator: `pending/${request.request_id}.v2.json`,
        request_file_digest: `sha256:${"1".repeat(64)}`, replayed: false, capability_verified: true,
        tombstone_sequence: request.tombstone_high_water.sequence,
        tombstone_set_root: request.tombstone_high_water.set_root, provider_instance_id: request.provider_instance_id }, now);
      const proofBody = { schema_version: 1, proof_type: "forget", provider_instance_id: "provider:fixture",
        provider_release_sha: "a".repeat(40), provider_signing_key_id: "provider-proof:fixture",
        request_id: request.request_id, request_digest: request.request_digest, envelope_digest: request.envelope_digest,
        idempotency_key: request.idempotency_key, delegation_id: request.delegation.delegation_id,
        delegation_digest: request.delegation.delegation_digest, lane_id: request.lane_id, operation: "forget",
        payload_digest: memoryEffectDigest("effect_payload", request.payload),
        target_manifest_digest: request.target_manifest_digest, scope_digest: request.scope_digest,
        base_generation_id: request.expected_prior.generation_id, base_head: request.expected_prior.vault_head,
        base_tree: request.expected_prior.vault_tree, result_generation_id: `sbgen:v1:${"b".repeat(64)}`,
        result_head: "c".repeat(40), result_tree: "d".repeat(40),
        tombstone_sequence: request.tombstone_high_water.sequence,
        tombstone_previous_root: String(request.tombstone_chain_delta[0]?.previous_root),
        tombstone_set_root: request.tombstone_high_water.set_root,
        activation_journal_digest: `sha256:${"2".repeat(64)}`, reader_drain_digest: `sha256:${"3".repeat(64)}`,
        predecessor_disposal_digest: `sha256:${"4".repeat(64)}`, backup_disposal_digest: `sha256:${"5".repeat(64)}`,
        export_disposal_digest: `sha256:${"6".repeat(64)}`, surface_manifest_digest: `sha256:${"7".repeat(64)}`,
        artifact_manifest_digest: null, export_manifest_digest: null,
        claimed_at: "2026-08-31T00:00:01.000Z", applied_at: "2026-08-31T00:00:02.000Z",
        completed_at: "2026-08-31T00:00:03.000Z" };
      const proofDigest = `sha256:${createHash("sha256").update("second-brain/memory-disposition-proof/v1\0")
        .update(canonicalize(proofBody)).digest("hex")}`;
      const unsigned = { ...proofBody, proof_id: `sbproof:v1:${proofDigest.slice(7)}`, proof_digest: proofDigest };
      const proof = { ...unsigned, signature: sign(null,
        Buffer.from(`second-brain/memory-disposition-proof/v1\0${canonicalize(unsigned)}`), providerPrivateKey).toString("base64url") };
      const status = { schema_version: 1, request_id: request.request_id, request_digest: request.request_digest,
        envelope_digest: request.envelope_digest, idempotency_key: request.idempotency_key, lane_id: request.lane_id,
        operation: request.operation, state: "proved", phase: "proved", fence: 1,
        tombstone_sequence: request.tombstone_high_water.sequence,
        tombstone_set_root: request.tombstone_high_water.set_root, status_digest: `sha256:${"8".repeat(64)}`, proof };
      recordMemoryEffectProviderStatus(db, request.request_id, status, new Date("2026-08-31T00:00:04.000Z"));
      expect(db.db.prepare("SELECT state,completed_at FROM memory_effect_requests WHERE request_id=?").get(request.request_id))
        .toEqual({ state: "completed", completed_at: "2026-08-31T00:00:03.000Z" });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM memory_erasure_ledger WHERE request_id=?").get(request.request_id))
        .toEqual({ n: 7 });
      expect(db.db.prepare("SELECT predecessor_disposed FROM memory_erasure_ledger WHERE event_type='deletion_proof'").get())
        .toEqual({ predecessor_disposed: 1 });
    } finally { db.close(); }
  });

  it("spends exact approved delegation once and rejects pre-use revocation", async () => {
    const db = new AuthorityDb(tempDb());
    try {
      await db.migrate();
      registerMemoryEffectDelegationKey(db, { key_id: "jarvis:fixture", principal_id: "principal:owner",
        public_key_pem: publicPem, valid_from: "2026-08-31T00:00:00.000Z", valid_until: "2026-09-01T00:00:00.000Z" },
      new Date("2026-08-31T00:00:00.000Z"));
      const correction = vector("correction"); controlAuthority(db, correction);
      const parsed = parseMemoryEffectWriteRequest(correction, {
        now, expectedProvider: "provider:fixture", delegationKeys: new Map([["jarvis:fixture", createPublicKey(privateKey)]]) });
      expect(parsed).toBeDefined();
      expect(hasMemoryEffectWriteAuthority(db, correction, now)).toBe(true);
      expect(prepareMemoryEffectDispatch(db, correction, now)).toEqual({ replayed: false });
      expect(prepareMemoryEffectDispatch(db, correction, now)).toEqual({ replayed: true });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM memory_effect_delegation_uses").get()).toEqual({ n: 1 });
      expect(() => db.db.prepare("UPDATE memory_effect_delegations SET nonce='changed'").run()).toThrow(/immutable/);

      const forget = vector("forget");
      const revocation = vectors.delegation_revocation;
      revokeMemoryEffectDelegation(db, { delegation_id: forget.delegation.delegation_id, reason: "owner_revoked",
        revoked_by: "principal:owner", revoked_at: "2026-08-31T00:00:00.500Z" }, now);
      expect(db.db.prepare("SELECT revocation_id,payload_digest FROM memory_effect_delegation_revocations").get())
        .toEqual({ revocation_id: revocation?.revocation_id, payload_digest: revocation?.revocation_digest });
      expect(hasMemoryEffectWriteAuthority(db, forget, now)).toBe(false);
    } finally { db.close(); }
  });
});
