import { canonicalize } from "../../src/canonical.js";
import { verifyMemoryDispositionProof } from "../../src/memory-disposition-proof.js";
import { registerMemoryProviderProofKey } from "../../src/memory-effect-delegation.js";
import { providerSurfaceInventory, reingressGuardObservations } from "./memory-surface-observations.js";
import { AuthorityDatabaseRuntime } from "../../src/authority-database-runtime.js";
import { MemoryAuthorityCompactor } from "../../src/memory-authority-compactor.js";
import { MemoryManagedSurfaceScanner } from "../../src/memory-managed-surface-scanner.js";
import type { CorrectionLifecycleObservation } from "../../src/memory-lifecycle-observation-types.js";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovedCommandExecutor,
  ControlPlane,
  MemoryCandidateStore,
  SecondBrainEffectService,
  signCommandApproval,
  type CommandApprovalReceipt,
  type ControlCommandRequestInput,
  type SecondBrainOutcome,
  type SecondBrainTransport,
  type SecondBrainWriteOutcome,
  type SecondBrainWriteRequestAdapter,
} from "../../src/index.js";
import { MemoryCorrectionSaga } from "../../src/memory-correction-saga.js";
import { registerMemoryEffectDelegationKey } from "../../src/memory-effect-delegation.js";
import {
  memoryEffectDigest,
  requireMemoryEffectWriteRequest,
  type MemoryEffectScopeV2,
  type MemoryEffectWriteRequestV2,
  type ResolvedMemoryTargetV2,
} from "../../src/second-brain-effect-v2.js";
import { localKey } from "../helpers.js";
import { memoryPolicy, verifiedMemoryInput } from "../fixtures/memory-candidate-fixture.js";
import {
  noopMemoryBarriers,
  notProvedMemoryObserver,
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
    const request = requireMemoryEffectWriteRequest(value, { now: NOW, expectedProvider: "provider:fixture",
      delegationKeys: new Map([["jarvis:fixture", createPublicKey(privateKey)]]) });
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

export async function correctionPreparedFixture() {
  const database = await memoryDatabase(); const db = database.authority;
  const root = mkdtempSync(join(tmpdir(), "jarvis-correction-control-"));
  let current = NOW; let observation: CorrectionLifecycleObservation | undefined;
  const writer = new AcceptedWriter(); const control = new ControlPlane(db);
  const input = verifiedMemoryInput({ authority_id: "correction-control",
    idempotency_key: "candidate:correction-control", operation: "correct" });
  insertMemoryVerification(db, memoryVerificationPayload(input));
  const candidate = new MemoryCandidateStore(db, memoryPolicy(), () => NOW).classify(input);
  const confirmation: ControlCommandRequestInput = { schema_version: 1, request_id: "correction-confirm",
    action: "memory.confirm", action_level: 3, target: { candidate_id: candidate.candidate_id,
      candidate_digest: candidate.candidate_digest, classification_digest: candidate.classification_digest },
    args: { schema_version: 1, operation: "correct", evidence_digest: `sha256:${"b".repeat(64)}` },
    reversible: false, requested_by: "principal:owner", requested_at: NOW.toISOString(),
    expires_at: EXPIRES, nonce: "nonce:correction-confirm" };
  approve(control, confirmation, localKey(db));
  const confirmed = await new ApprovedCommandExecutor(db, undefined, undefined, {}, () => NOW)
    .execute(confirmation.request_id, "fixture", NOW);
  if (confirmed.state !== "completed") throw new Error(JSON.stringify(confirmed));
  registerMemoryEffectDelegationKey(db, { key_id: "jarvis:fixture", principal_id: "principal:owner",
    public_key_pem: createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString(),
    valid_from: NOW.toISOString(), valid_until: "2026-08-29T12:00:00.000Z" }, NOW);
  const transport: SecondBrainTransport = {
    call: async (): Promise<SecondBrainOutcome> => ({ kind: "data", value: { schema_version: 1,
      provider_instance_id: "provider:fixture", provider_release_sha: "a".repeat(40),
      generation_id: target().generation_id, generation_manifest_digest: target().generation_manifest_digest,
      vault_head: target().vault_head, vault_tree: target().vault_tree, tombstone_sequence: 0,
      tombstone_set_root: "sha256:7fb694c8abb7c9a4477aa38381c49446493bc4da1c01b50690c1db5b2c20b9d3",
      pointer_health: "healthy", journal_health: "healthy", features: ["memory_effect_write_v2"] } }),
    restart: async () => undefined, close: async () => undefined, diagnostics: () => [],
  };
  const provider = new SecondBrainEffectService({ authority: db, transport, writer, clock: () => current,
    provider_instance_id: "provider:fixture", signing_key_id: "jarvis:fixture", private_key: privateKey });
  const layout = { spool_root: join(root,"spool"), state_root: join(root,"state"), dist_root: join(root,"dist"),
    backup_root: join(root,"backups"), restore_root: join(root,"restore") };
  for (const path of Object.values(layout)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const databaseRuntime = new AuthorityDatabaseRuntime(db, { registry_root: join(root,"registry"), watchdog_ms: 5000 });
  const compactor = new MemoryAuthorityCompactor({ runtime: databaseRuntime,
    scanner: new MemoryManagedSurfaceScanner({ authority: db, layout }), layout, clock: () => current });
  const runtime = { authority: db, spool_root: layout.spool_root, writer, provider,
    signing_key_id: "jarvis:fixture", private_key: privateKey, subject_key: Buffer.alloc(32,3),
    clock: () => current, observer: { ...notProvedMemoryObserver,
      correction: async () => observation ?? { kind: "not_proved" as const, code: "TEST_PENDING" } },
    compactor, barriers: noopMemoryBarriers(db) };
  const saga = new MemoryCorrectionSaga(runtime);
  const action = await saga.prepare({ control_request_id: "correction-dispatch", candidate_id: candidate.candidate_id,
    provider_instance_id: "provider:fixture", targets: [target()], scope: scope(), content: "Corrected fixture memory.",
    requested_at: NOW, expires_at: new Date(EXPIRES), nonce: "nonce:correction-dispatch" });
  approve(control, action, localKey(db));
  const claim = control.claim(action.request_id, "fixture", NOW);
  return { database, db, root, control, action, claim, candidate, writer, saga, runtime, databaseRuntime,
    setTime: (now: Date) => { current = now; },
    setObservation: (value: CorrectionLifecycleObservation) => { observation = value; },
    close: async () => { await databaseRuntime.close(); closeMemoryDatabase(database); rmSync(root,{recursive:true,force:true}); } };
}
export async function correctionControlFixture() {
  const fixture = await correctionPreparedFixture();
  try { return { ...fixture, record: await fixture.saga.dispatch(fixture.claim) }; }
  catch (error) { await fixture.close(); throw error; }
}
export function correctionObservation(fixture: Awaited<ReturnType<typeof correctionControlFixture>>): CorrectionLifecycleObservation {
  const request = fixture.writer.calls[0];
  if (!request) throw new Error("NO_DISPATCH");
  const tombstoneDelta = request.tombstone_chain_delta[0];
  if (!tombstoneDelta) throw new Error("NO_TOMBSTONE");
  const providerKey = privateKey;
  registerMemoryProviderProofKey(fixture.db, { key_id: "provider:key", provider_instance_id: request.provider_instance_id,
    provider_release_sha: "a".repeat(40), public_key_pem: createPublicKey(providerKey).export({format:"pem",type:"spki"}).toString(),
    valid_from: NOW.toISOString(), valid_until: "2026-08-29T12:00:00.000Z" }, NOW);

  const body = { schema_version: 1, proof_type: "correction", provider_instance_id: request.provider_instance_id,
    provider_release_sha: "a".repeat(40), provider_signing_key_id: "provider:key",
    request_id: request.request_id, request_digest: request.request_digest,
    envelope_digest: request.envelope_digest, idempotency_key: request.idempotency_key,
    delegation_id: request.delegation.delegation_id, delegation_digest: request.delegation.delegation_digest,
    lane_id: request.lane_id, operation: request.operation, payload_digest: request.delegation.payload_digest,
    target_manifest_digest: request.target_manifest_digest, scope_digest: request.scope_digest,
    base_generation_id: request.expected_prior.generation_id, base_head: request.expected_prior.vault_head,
    base_tree: request.expected_prior.vault_tree, result_generation_id: `sbgen:v1:${"b".repeat(64)}`,
    result_head: "c".repeat(40), result_tree: "d".repeat(40),
    tombstone_sequence: request.tombstone_high_water.sequence,
    tombstone_previous_root: tombstoneDelta.previous_root,
    tombstone_set_root: request.tombstone_high_water.set_root,
    activation_journal_digest: `sha256:${"1".repeat(64)}`, reader_drain_digest: `sha256:${"2".repeat(64)}`,
    predecessor_disposal_digest: `sha256:${"3".repeat(64)}`, backup_disposal_digest: `sha256:${"4".repeat(64)}`,
    export_disposal_digest: `sha256:${"5".repeat(64)}`, surface_manifest_digest: `sha256:${"6".repeat(64)}`,
    artifact_manifest_digest: `sha256:${"7".repeat(64)}`, export_manifest_digest: null,
    claimed_at: NOW.toISOString(), applied_at: NOW.toISOString(),
    completed_at: NOW.toISOString() };
  const proofDigest = `sha256:${createHash("sha256").update("second-brain/memory-disposition-proof/v1\0")
    .update(canonicalize(body)).digest("hex")}`;
  const unsigned = { ...body, proof_id: `sbproof:v1:${proofDigest.slice(7)}`, proof_digest: proofDigest };
  const signed = { ...unsigned, signature: sign(null,
    Buffer.from(`second-brain/memory-disposition-proof/v1\0${canonicalize(unsigned)}`), providerKey).toString("base64url") };
  const proof = verifyMemoryDispositionProof(fixture.db, signed, { ...fixture.record, operation: "correct" }, NOW);
  return { kind: "correction", proof,
    generation: { generation_id: proof.result_generation_id, generation_manifest_digest: `sha256:${"b".repeat(64)}`,
      tombstone_sequence: proof.tombstone_sequence, tombstone_set_root: proof.tombstone_set_root },
    replacement: { kind: "correction", artifact_manifest_digest: proof.artifact_manifest_digest!,
      target_manifest_digest: proof.target_manifest_digest, file_count: 1, byte_count: 64,
      artifact_match_count: 1, absence_match_count: 0 },
    provider_inventory: providerSurfaceInventory(), reingress_guards: reingressGuardObservations() };
}
