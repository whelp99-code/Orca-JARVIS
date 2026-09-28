import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApprovedCommandExecutor,
  ControlPlane,
  MemoryCandidateStore,
  SecondBrainEffectService,
  signCommandApproval,
  type CommandApprovalReceipt,
  type ControlCommandRequestInput,
  type SecondBrainMethod,
  type SecondBrainOutcome,
  type SecondBrainTransport,
  type SecondBrainWriteOutcome,
  type SecondBrainWriteRequestAdapter,
} from "../../src/index.js";
import { MemoryCorrectionSaga } from "../../src/memory-correction-saga.js";
import { ProductionMemoryLifecycleObserver } from "../../src/memory-lifecycle-observer.js";
import { registerMemoryEffectDelegationKey } from "../../src/memory-effect-delegation.js";
import { isMemorySuppressed } from "../../src/memory-suppression.js";
import { subscribeMemorySuppression } from "../../src/memory-suppression-events.js";
import {
  memoryEffectDigest,
  type MemoryEffectScopeV2,
  type MemoryEffectWriteRequestV2,
  type ResolvedMemoryTargetV2,
} from "../../src/second-brain-effect-v2.js";
import { localKey } from "../helpers.js";
import { memoryPolicy, verifiedMemoryInput } from "../fixtures/memory-candidate-fixture.js";
import {
  noopMemoryBarriers,
  notProvedMemoryObserver,
  unreachableMemoryCompactor,
} from "../fixtures/memory-lifecycle-runtime.js";
import {
  closeMemoryDatabase,
  insertMemoryVerification,
  memoryDatabase,
  memoryVerificationPayload,
} from "../fixtures/memory-candidate-store.js";

const NOW = new Date("2026-08-28T12:00:00.000Z");
const EXPIRES = "2026-08-28T12:05:00.000Z";
const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
  ]),
  format: "der",
  type: "pkcs8",
});

function target(): ResolvedMemoryTargetV2 {
  const core = {
    schema_version: 1 as const,
    provider_instance_id: "provider:fixture",
    generation_id: `sbgen:v1:${"2".repeat(64)}`,
    generation_manifest_digest: `sha256:${"2".repeat(64)}`,
    vault_head: "3".repeat(40),
    vault_tree: "4".repeat(40),
    page_id: "wiki/runtime-memory",
    page_blob_oid: "5".repeat(40),
    page_content_digest: `sha256:${"5".repeat(64)}`,
    source_identity_full: "6".repeat(64),
    content_identity_full: "7".repeat(64),
    citation_identity_full: "8".repeat(64),
    citation_span_start: 10,
    citation_span_end: 20,
    subject_digest: `sha256:${"9".repeat(64)}`,
    sensitivity: "personal" as const,
    valid_from: NOW.toISOString(),
    valid_until: "2026-08-29T12:00:00.000Z",
    source_owner_class: "provider_owned" as const,
    source_owner_id_digest: `sha256:${"a".repeat(64)}`,
    resolved_at: NOW.toISOString(),
    expires_at: EXPIRES,
  };
  const targetDigest = memoryEffectDigest("target", core);
  return { ...core, target_id: `sbtarget:v1:${targetDigest.slice(7)}`,
    target_digest: targetDigest };
}
function scope(): MemoryEffectScopeV2 {
  return { format: "none", sensitivity_classes: ["personal"],
    valid_from: NOW.toISOString(), valid_until: "2026-08-29T12:00:00.000Z",
    max_records: 1, max_bytes: 4_096, source_owner_classes: ["provider_owned"] };
}
function approve(control: ControlPlane, input: ControlCommandRequestInput,
  key: ReturnType<typeof localKey>): void {
  const staged = control.stage(input, NOW);
  const receipt: Omit<CommandApprovalReceipt, "signature"> = {
    schema_version: 1, receipt_id: `approval:${input.request_id}`, request_id: input.request_id,
    decision: "approve", command_digest: staged.command_digest,
    signer_principal_id: "principal:owner", authenticated_session_id: "task30",
    key_id: "decision-test", algorithm: "Ed25519", issued_at: NOW.toISOString(),
    not_before: NOW.toISOString(), expires_at: input.expires_at,
    nonce: `approval-nonce:${input.request_id}`, max_uses: 1, status: "issued",
  };
  control.decide(signCommandApproval(receipt, key), NOW);
}
class AcceptedWriter implements SecondBrainWriteRequestAdapter {
  readonly calls: MemoryEffectWriteRequestV2[] = [];
  constructor(private readonly beforeWrite: () => void = () => undefined) {}
  write(value: unknown): Promise<SecondBrainWriteOutcome> {
    this.beforeWrite();
    const request = value as MemoryEffectWriteRequestV2;
    this.calls.push(request);
    return Promise.resolve({ schema_version: 2, kind: "accepted", state: "pending",
      request_id: request.request_id, request_digest: request.request_digest,
      idempotency_key: request.idempotency_key, envelope_digest: request.envelope_digest,
      lane: request.lane, operation: request.operation, accepted_at: NOW.toISOString(),
      queue_locator: `pending/${request.request_id}.v2.json`,
      request_file_digest: `sha256:${"1".repeat(64)}`, replayed: false,
      capability_verified: true, tombstone_sequence: request.tombstone_high_water.sequence,
      tombstone_set_root: request.tombstone_high_water.set_root,
      provider_instance_id: request.provider_instance_id });
  }
}

describe("proof-bound memory correction saga", () => {
  it("keeps control reconciling and suppression active while provider is pending without DB plaintext", async () => {
    const database = await memoryDatabase();
    const db = database.authority;
    const corrected = `corrected-${randomUUID()}-${randomUUID()}`;
    let suppressionSeen = false;
    const writer = new AcceptedWriter(() => { expect(suppressionSeen).toBe(true); });
    try {
      const candidateInput = verifiedMemoryInput({ authority_id: "task30-correction",
        idempotency_key: "candidate:task30:correction", operation: "correct",
        subject: "Runtime memory", statement: "Prior runtime value" });
      insertMemoryVerification(db, memoryVerificationPayload(candidateInput));
      const candidate = new MemoryCandidateStore(db, memoryPolicy(), () => NOW).classify(candidateInput);
      expect(candidate.state).toBe("awaiting_confirmation");
      const control = new ControlPlane(db);
      const confirmation: ControlCommandRequestInput = { schema_version: 1,
        request_id: "task30-confirm", action: "memory.confirm", action_level: 3,
        target: { candidate_id: candidate.candidate_id, candidate_digest: candidate.candidate_digest,
          classification_digest: candidate.classification_digest },
        args: { schema_version: 1, operation: "correct",
          evidence_digest: `sha256:${"b".repeat(64)}` }, reversible: false,
        requested_by: "principal:owner", requested_at: NOW.toISOString(), expires_at: EXPIRES,
        nonce: "nonce:task30-confirm" };
      approve(control, confirmation, localKey(db));
      const confirmationResult = await new ApprovedCommandExecutor(db, undefined, undefined, {}, () => NOW)
        .execute(confirmation.request_id, "task30-confirm", NOW);
      expect(confirmationResult.state, JSON.stringify(confirmationResult)).toBe("completed");
      registerMemoryEffectDelegationKey(db, { key_id: "jarvis:fixture",
        principal_id: "principal:owner",
        public_key_pem: createPublicKey(privateKey)
          .export({ format: "pem", type: "spki" }).toString(),
        valid_from: NOW.toISOString(), valid_until: "2026-08-29T12:00:00.000Z" }, NOW);
      const transport: SecondBrainTransport = {
        call: async (method: SecondBrainMethod): Promise<SecondBrainOutcome> => method === "sb_request_status"
          ? { kind: "data", value: { schema_version: 1, request_id: writer.calls[0]?.request_id,
            state: "pending" } }
          : { kind: "data", value: { schema_version: 1, provider_instance_id: "provider:fixture",
            provider_release_sha: "a".repeat(40), generation_id: target().generation_id,
            generation_manifest_digest: target().generation_manifest_digest,
            vault_head: target().vault_head, vault_tree: target().vault_tree,
            tombstone_sequence: 0,
            tombstone_set_root: "sha256:7fb694c8abb7c9a4477aa38381c49446493bc4da1c01b50690c1db5b2c20b9d3",
            pointer_health: "healthy", journal_health: "healthy",
            features: ["memory_effect_write_v2"] } },
        restart: async () => undefined, close: async () => undefined, diagnostics: () => [],
      };
      const provider = new SecondBrainEffectService({ authority: db, transport, writer,
        clock: () => NOW, provider_instance_id: "provider:fixture",
        signing_key_id: "jarvis:fixture", private_key: privateKey,
        nonce: () => "task30-correction" });
      const spoolRoot = join(mkdtempSync(join(tmpdir(), "jarvis-task30-spool-")), "memory-effects");
      const saga = new MemoryCorrectionSaga({ authority: db, spool_root: spoolRoot,
        writer, provider, signing_key_id: "jarvis:fixture", private_key: privateKey,
        subject_key: Buffer.alloc(32, 3), clock: () => NOW,
        observer: notProvedMemoryObserver, compactor: unreachableMemoryCompactor,
        barriers: noopMemoryBarriers(db) });
      const action = await saga.prepare({ control_request_id: "task30-correction",
        candidate_id: candidate.candidate_id, provider_instance_id: "provider:fixture",
        targets: [target()], scope: scope(), content: corrected, requested_at: NOW,
        expires_at: new Date(EXPIRES), nonce: "nonce:task30-correction" });
      approve(control, action, localKey(db));
      const unsubscribe = subscribeMemorySuppression(db, event => {
        suppressionSeen = event.sequence === 1 && event.projection_count === 0;
      });
      const lifecycle = { async execute(command: Parameters<MemoryCorrectionSaga["dispatch"]>[0]) {
        const dispatched = await saga.dispatch(command);
        const reconciled = await saga.reconcile(dispatched.correction_id);
        return { kind: "correction" as const, id: reconciled.correction_id,
          state: reconciled.state, request_digest: reconciled.request_digest };
      } };
      const executor = new ApprovedCommandExecutor(db, undefined, undefined, {}, () => NOW,
        undefined, provider, lifecycle);
      const execution = await executor.execute(action.request_id, "task30-correction", NOW);
      unsubscribe();
      const correction = db.db.prepare(
        "SELECT state FROM memory_correction_requests",
      ).get() as { readonly state: string };
      const controlState = db.db.prepare(
        "SELECT state FROM control_command_requests WHERE request_id=?",
      ).get(action.request_id) as { readonly state: string };
      expect(execution).toMatchObject({ state: "uncertain",
        failure_code: "MEMORY_CORRECTION_RECONCILING" });
      expect(correction.state).toBe("reconciling");
      expect(controlState.state).toBe("claimed");
      expect(writer.calls).toHaveLength(1);
      expect(isMemorySuppressed(db, { target_digest: target().target_digest })).toBe(true);
      const prepared = db.db.prepare(
        `SELECT effective_at,request_id,request_digest,request_tombstone_sequence
         FROM memory_effect_preparations WHERE lane='correction'`,
      ).get();
      expect(prepared).toEqual({ effective_at: NOW.toISOString(),
        request_id: writer.calls[0]?.request_id, request_digest: writer.calls[0]?.request_digest,
        request_tombstone_sequence: 1 });
      expect(db.db.prepare(
        "SELECT active_lane_id,accepted_through_sequence FROM memory_effect_dispatch_cursor",
      ).get()).toEqual({ active_lane_id: null, accepted_through_sequence: 1 });
      db.close();
      expect(readFileSync(db.filename).includes(Buffer.from(corrected, "utf8"))).toBe(false);
    } finally {
      if (db.db.open) closeMemoryDatabase(database);
      else {
        rmSync(database.root, { recursive: true, force: true });
        rmSync(database.anchorsRoot, { recursive: true, force: true });
      }
    }
  });

  it("ends a correction the provider refused before any effect instead of reconciling forever", async () => {
    const database = await memoryDatabase();
    const db = database.authority;
    const corrected = `corrected-${randomUUID()}-${randomUUID()}`;
    const writer = new AcceptedWriter();
    try {
      const candidateInput = verifiedMemoryInput({ authority_id: "task30-refused",
        idempotency_key: "candidate:task30:refused", operation: "correct",
        subject: "Runtime memory", statement: "Prior runtime value" });
      insertMemoryVerification(db, memoryVerificationPayload(candidateInput));
      const candidate = new MemoryCandidateStore(db, memoryPolicy(), () => NOW).classify(candidateInput);
      const control = new ControlPlane(db);
      const confirmation: ControlCommandRequestInput = { schema_version: 1,
        request_id: "task30-refused-confirm", action: "memory.confirm", action_level: 3,
        target: { candidate_id: candidate.candidate_id, candidate_digest: candidate.candidate_digest,
          classification_digest: candidate.classification_digest },
        args: { schema_version: 1, operation: "correct",
          evidence_digest: `sha256:${"b".repeat(64)}` }, reversible: false,
        requested_by: "principal:owner", requested_at: NOW.toISOString(), expires_at: EXPIRES,
        nonce: "nonce:task30-refused-confirm" };
      approve(control, confirmation, localKey(db));
      expect((await new ApprovedCommandExecutor(db, undefined, undefined, {}, () => NOW)
        .execute(confirmation.request_id, "task30-refused-confirm", NOW)).state).toBe("completed");
      registerMemoryEffectDelegationKey(db, { key_id: "jarvis:fixture",
        principal_id: "principal:owner",
        public_key_pem: createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString(),
        valid_from: NOW.toISOString(), valid_until: "2026-08-29T12:00:00.000Z" }, NOW);
      // The provider journalled the request, then refused it before the apply phase began.
      const transport: SecondBrainTransport = {
        call: async (method: SecondBrainMethod): Promise<SecondBrainOutcome> => method === "sb_request_status"
          ? { kind: "data", value: { schema_version: 1, request_id: writer.calls[0]?.request_id,
            state: "failed", phase: "claimed", fence: 1 } }
          : { kind: "data", value: { schema_version: 1, provider_instance_id: "provider:fixture",
            provider_release_sha: "a".repeat(40), generation_id: target().generation_id,
            generation_manifest_digest: target().generation_manifest_digest,
            vault_head: target().vault_head, vault_tree: target().vault_tree,
            tombstone_sequence: 0,
            tombstone_set_root: "sha256:7fb694c8abb7c9a4477aa38381c49446493bc4da1c01b50690c1db5b2c20b9d3",
            pointer_health: "healthy", journal_health: "healthy",
            features: ["memory_effect_write_v2"] } },
        restart: async () => undefined, close: async () => undefined, diagnostics: () => [],
      };
      const provider = new SecondBrainEffectService({ authority: db, transport, writer,
        clock: () => NOW, provider_instance_id: "provider:fixture",
        signing_key_id: "jarvis:fixture", private_key: privateKey, nonce: () => "task30-refused" });
      const spoolRoot = join(mkdtempSync(join(tmpdir(), "jarvis-task30-refused-")), "memory-effects");
      const saga = new MemoryCorrectionSaga({ authority: db, spool_root: spoolRoot,
        writer, provider, signing_key_id: "jarvis:fixture", private_key: privateKey,
        subject_key: Buffer.alloc(32, 3), clock: () => NOW,
        observer: new ProductionMemoryLifecycleObserver({ authority: db, provider,
          observations: { observe: () => Promise.reject(new Error("TEST_OBSERVATION_MUST_NOT_RUN")) },
          clock: () => NOW }),
        compactor: unreachableMemoryCompactor, barriers: noopMemoryBarriers(db) });
      const action = await saga.prepare({ control_request_id: "task30-refused",
        candidate_id: candidate.candidate_id, provider_instance_id: "provider:fixture",
        targets: [target()], scope: scope(), content: corrected, requested_at: NOW,
        expires_at: new Date(EXPIRES), nonce: "nonce:task30-refused" });
      approve(control, action, localKey(db));
      const claimed = control.claim(action.request_id, "task30-refused", NOW);
      const dispatched = await saga.dispatch(claimed);
      expect(writer.calls).toHaveLength(1);

      const settled = await saga.reconcile(dispatched.correction_id);

      // The lane is terminal, so no later reconcile pass keeps re-observing a decided request.
      expect(settled.state).toBe("conflict");
      expect(settled.failure_code).toBe("MEMORY_PROVIDER_FAILED");
      expect(db.db.prepare("SELECT state,failure_code FROM control_command_requests WHERE request_id=?")
        .get(action.request_id)).toEqual({ state: "failed", failure_code: "MEMORY_PROVIDER_FAILED" });
      expect(db.db.prepare(
        "SELECT event_type FROM memory_correction_events WHERE correction_id=? ORDER BY sequence DESC LIMIT 1",
      ).get(dispatched.correction_id)).toEqual({ event_type: "conflict" });
      // Refusal is observation, not a second write: no replay and no renewed provider frame.
      expect(await saga.reconcile(dispatched.correction_id)).toMatchObject({ state: "conflict" });
      expect(writer.calls).toHaveLength(1);
    } finally {
      if (db.db.open) closeMemoryDatabase(database);
      else {
        rmSync(database.root, { recursive: true, force: true });
        rmSync(database.anchorsRoot, { recursive: true, force: true });
      }
    }
  });
});
