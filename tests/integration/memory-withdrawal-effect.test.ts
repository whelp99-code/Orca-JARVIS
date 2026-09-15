import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt } from "../../src/control-plane.js";
import { MemoryDeletionSaga } from "../../src/memory-deletion-saga.js";
import { registerMemoryEffectDelegationKey } from "../../src/memory-effect-delegation.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { memoriesAwaitingTaskWithdrawal, recordCandidateTaskSource } from "../../src/memory-candidate-task-source.js";
import { MemoryTargetResolver } from "../../src/memory-target-resolver.js";
import { MemoryWithdrawalEffect } from "../../src/memory-withdrawal-effect.js";
import { SecondBrainEffectService } from "../../src/second-brain-effect-service.js";
import { createSecondBrainReadAdapter } from "../../src/second-brain-adapter.js";
import type { SecondBrainWriteOutcome, SecondBrainWriteRequestAdapter } from "../../src/second-brain-adapter-types.js";
import { memoryEffectDigest, type MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import { MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import {
  noopMemoryBarriers, notProvedMemoryObserver, unreachableMemoryCompactor,
} from "../fixtures/memory-lifecycle-runtime.js";
import { MemoryReferenceProvider, REFERENCE_GENERATION, REFERENCE_NOW } from "../fixtures/memory-reference-provider.js";
import { settleRememberWrite } from "../fixtures/memory-remember-settlement.js";
import { localKey } from "../helpers.js";

const TASK = "task:withdrawal-effect";
const NOW = new Date(MEMORY_NOW);
const KEY_ID = "jarvis:withdrawal";
const open: MemoryDatabase[] = [];
afterEach(() => { for (const database of open.splice(0)) closeMemoryDatabase(database); });

const effectKey = generateKeyPairSync("ed25519").privateKey;

/** A provider that accepts one effect write durably, so dispatch has somewhere real to land. */
function acceptingWriter(calls: MemoryEffectWriteRequestV2[]): SecondBrainWriteRequestAdapter {
  return { write(value: unknown): Promise<SecondBrainWriteOutcome> {
    const effect = value as MemoryEffectWriteRequestV2;
    calls.push(effect);
    return Promise.resolve({ schema_version: 2, kind: "accepted", state: "pending",
      request_id: effect.request_id, request_digest: effect.request_digest,
      idempotency_key: effect.idempotency_key, envelope_digest: effect.envelope_digest,
      lane: effect.lane, operation: effect.operation, accepted_at: NOW.toISOString(),
      queue_locator: `pending/${effect.request_id}.v2.json`,
      request_file_digest: `sha256:${"1".repeat(64)}`, replayed: false, capability_verified: true,
      tombstone_sequence: effect.tombstone_high_water.sequence,
      tombstone_set_root: effect.tombstone_high_water.set_root,
      provider_instance_id: effect.provider_instance_id });
  } };
}

/**
 * One derived memory stored through the product, its task then hidden.
 *
 * Everything before the withdrawal is the real path: classification, owner confirmation, the
 * dispatch the product derives, settlement against the records that destination carries, and the
 * target the provider resolved for that record. Only then is the task hidden.
 */
async function storedAndHidden(options: { readonly statement?: string } = {}) {
  const database = await memoryDatabase();
  open.push(database);
  const authority = database.authority;
  const settled = await settleRememberWrite(database, {
    statement: options.statement ?? "WithdrawalEffectStatement",
    idempotency_key: "candidate:withdrawal-effect", receipt_prefix: "withdrawal-effect" });
  recordCandidateTaskSource(authority, settled.candidate.candidate_id, TASK, NOW);
  const provider = new MemoryReferenceProvider(settled.page);
  provider.statusOverrides = { features: ["memory_effect_write_v2"] };
  const calls: MemoryEffectWriteRequestV2[] = [];
  const writer = acceptingWriter(calls);
  const effect = new SecondBrainEffectService({ authority, transport: provider, writer,
    clock: () => NOW, provider_instance_id: REFERENCE_GENERATION.provider_instance_id,
    signing_key_id: KEY_ID, private_key: effectKey });
  // The first resolve is the one the write itself recorded: it is what puts a target_id on the
  // withdrawal list at all.
  const first = await effect.resolveTarget({ record_id: String(settled.record["record_id"]),
    record_digest: String(settled.record["record_digest"]),
    generation_id: REFERENCE_GENERATION.generation_id,
    generation_manifest_digest: REFERENCE_GENERATION.generation_manifest_digest });
  if (first.kind !== "data") throw new TypeError(`target resolution required: ${first.kind}`);
  new MemoryProjectionAuthority(authority)
    .quarantineUnresolved({ kind: "task_timeline", id: TASK, component_id: TASK }, NOW);
  const reader = createSecondBrainReadAdapter({ transport: provider, clock: () => REFERENCE_NOW,
    contract_profile: "schema4", read_fence: at => effect.readFence("memory_read", at),
    budget_profile: "record-set-v1",
    budgets: { max_hits: 8, max_excerpt_bytes: 4_096, max_total_bytes: 262_144, max_page_bytes: 262_144 },
    max_age_ms: 7 * 86_400_000, expiry_ms: 30 * 86_400_000 });
  const withdrawal = new MemoryWithdrawalEffect({ authority, reader,
    resolver: new MemoryTargetResolver(effect), clock: () => NOW });
  return { database, authority, settled, provider, effect, writer, calls, withdrawal, reader };
}

function approveAndClaim(authority: MemoryDatabase["authority"], action: {
  readonly request_id: string; readonly expires_at: string;
}, tag: string) {
  const control = new ControlPlane(authority);
  const staged = control.stage(action as never, NOW);
  const receipt: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1,
    receipt_id: `approval:${tag}`, request_id: action.request_id, decision: "approve",
    command_digest: staged.command_digest, signer_principal_id: "principal:owner",
    authenticated_session_id: "owner-session", key_id: "decision-test", algorithm: "Ed25519",
    issued_at: NOW.toISOString(), not_before: NOW.toISOString(), expires_at: action.expires_at,
    nonce: `approval-nonce:${tag}`, max_uses: 1, status: "issued" };
  control.decide(signCommandApproval(receipt, localKey(authority)), NOW);
  return { control, receipt_id: receipt.receipt_id };
}

/**
 * The whole withdrawal, end to end, on the route that already exists.
 *
 * A hidden task's stored copy is resolved against the provider now, mapped onto the resolved target
 * the deletion contract requires, prepared as an owner-approval command, approved by a signed
 * receipt through the control plane, and dispatched by the real deletion saga. The evidence that the
 * withdrawal took effect is that the list of what is still out there is empty afterwards - not that
 * a call returned.
 */
it("withdraws a stored derived memory once its task is hidden and empties the outstanding list", async () => {
  const context = await storedAndHidden();
  const { authority } = context;
  registerMemoryEffectDelegationKey(authority, { key_id: KEY_ID, principal_id: "principal:owner",
    public_key_pem: createPublicKey(effectKey).export({ format: "pem", type: "spki" }).toString(),
    valid_from: "2026-01-01T00:00:00.000Z", valid_until: "2027-01-01T00:00:00.000Z" }, NOW);

  const outstanding = memoriesAwaitingTaskWithdrawal(authority);
  expect(outstanding).toHaveLength(1);
  expect(outstanding[0]?.target_id).not.toBeNull();

  const plan = await context.withdrawal.plan();
  expect(plan.refused).toEqual([]);
  expect(plan.resolved).toHaveLength(1);
  const entry = plan.resolved[0];
  if (entry === undefined) throw new TypeError("resolved withdrawal required");
  expect(entry.target.target_digest).toBe(outstanding[0]?.target_digest);

  const saga = new MemoryDeletionSaga({ authority, spool_root: `${context.database.root}/withdraw`,
    writer: context.writer, provider: context.effect, signing_key_id: KEY_ID,
    private_key: effectKey, subject_key: Buffer.alloc(32, 9), clock: () => NOW,
    observer: notProvedMemoryObserver, compactor: unreachableMemoryCompactor,
    barriers: noopMemoryBarriers(authority) });
  const action = await context.withdrawal.prepare(entry, input => saga.prepare(input));
  expect(action.action).toBe("memory.delete");
  const { control } = approveAndClaim(authority, action, "withdraw");
  const row = await saga.dispatch(control.claim(action.request_id, "withdraw-worker", NOW));

  expect(row.state).toBe("reconciling");
  expect(context.calls).toHaveLength(1);
  expect(memoriesAwaitingTaskWithdrawal(authority)).toEqual([]);
}, 120_000);

/**
 * A target the provider really would issue, for a state that is no longer the recorded one.
 *
 * The overrides are folded into the core and the digest is recomputed over it exactly as the
 * provider does, so the answer is internally consistent: it passes the contract's own parser and
 * the refusal has to come from the withdrawal comparing it against what the write recorded.
 */
function reissued(
  target: Readonly<Record<string, unknown>>, overrides: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const core: Record<string, unknown> = { ...target, ...overrides };
  delete core["target_id"];
  delete core["target_digest"];
  const digest = memoryEffectDigest("target", core);
  return { ...core, target_id: `sbtarget:v1:${digest.slice(7)}`, target_digest: digest };
}

function interceptResolve(provider: MemoryReferenceProvider,
  rewrite: (value: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>): void {
  const original = provider.call.bind(provider);
  provider.call = async (method, args) => {
    const outcome = await original(method, args);
    if (method !== "sb_resolve_memory_target" || outcome.kind !== "data") return outcome;
    return { kind: "data", value: rewrite(outcome.value) };
  };
}

/**
 * A consistent provider answer naming a target other than the recorded one is refused.
 *
 * This is the case where the provider is honest and the answer is well formed, but it is about a
 * different citation than the one the write recorded. Nothing may be prepared from it: an owner
 * approving a withdrawal is approving the removal of one identified record.
 */
it("refuses a resolve whose target identity is not the stored one", async () => {
  const context = await storedAndHidden();
  interceptResolve(context.provider, value =>
    reissued(value, { citation_span_start: 4_096, citation_span_end: 4_192 }));
  const plan = await context.withdrawal.plan();
  expect(plan.resolved).toEqual([]);
  expect(plan.refused).toHaveLength(1);
  expect(plan.refused[0]?.code).toBe("MEMORY_WITHDRAWAL_TARGET_CHANGED");
});

/** Once the page moved on, the provider resolves a different target and the withdrawal stops. */
it("refuses a withdrawal resolved after the page changed", async () => {
  const context = await storedAndHidden();
  // The same record on a page whose bytes moved: the blob the page is and the digest over its
  // content are both part of the target identity, so a changed page is a changed target.
  interceptResolve(context.provider, value => reissued(value, { page_blob_oid: "9".repeat(40),
    page_content_digest: `sha256:${"c".repeat(64)}` }));
  const plan = await context.withdrawal.plan();
  expect(plan.resolved).toEqual([]);
  expect(plan.refused).toHaveLength(1);
  expect(plan.refused[0]?.code).toBe("MEMORY_WITHDRAWAL_TARGET_CHANGED");
});

/**
 * An answer the contract does not recognise never reaches the comparison at all.
 *
 * A field this product does not know about, or a digest that does not bind the answer it came with,
 * is refused by the shared target parser - which is what keeps a provider from widening the
 * withdrawal contract by answering with more than it was asked.
 */
it("refuses a resolve carrying a field the target contract does not define", async () => {
  const context = await storedAndHidden();
  interceptResolve(context.provider, value => ({ ...value, provider_hint: "extra" }));
  const plan = await context.withdrawal.plan();
  expect(plan.resolved).toEqual([]);
  expect(plan.refused[0]?.code).toBe("SECOND_BRAIN_TARGET_RESULT_INVALID");

  const tampered = await storedAndHidden();
  interceptResolve(tampered.provider, value => ({ ...value,
    target_digest: `sha256:${"a".repeat(64)}`, target_id: `sbtarget:v1:${"a".repeat(64)}` }));
  expect((await tampered.withdrawal.plan()).refused[0]?.code)
    .toBe("SECOND_BRAIN_TARGET_RESULT_INVALID");
}, 120_000);

/** A revoked approval dispatches nothing, and the copy stays on the outstanding list. */
it("dispatches nothing when the owner revokes the withdrawal approval", async () => {
  const context = await storedAndHidden();
  const { authority } = context;
  registerMemoryEffectDelegationKey(authority, { key_id: KEY_ID, principal_id: "principal:owner",
    public_key_pem: createPublicKey(effectKey).export({ format: "pem", type: "spki" }).toString(),
    valid_from: "2026-01-01T00:00:00.000Z", valid_until: "2027-01-01T00:00:00.000Z" }, NOW);
  const plan = await context.withdrawal.plan();
  const entry = plan.resolved[0];
  if (entry === undefined) throw new TypeError("resolved withdrawal required");
  const saga = new MemoryDeletionSaga({ authority, spool_root: `${context.database.root}/withdraw`,
    writer: context.writer, provider: context.effect, signing_key_id: KEY_ID,
    private_key: effectKey, subject_key: Buffer.alloc(32, 9), clock: () => NOW,
    observer: notProvedMemoryObserver, compactor: unreachableMemoryCompactor,
    barriers: noopMemoryBarriers(authority) });
  const action = await context.withdrawal.prepare(entry, input => saga.prepare(input));
  const { control } = approveAndClaim(authority, action, "withdraw-revoked");
  control.cancel({ request_id: action.request_id, reason: "owner_withdrew_approval",
    actor: "principal:owner", revoked_at: NOW.toISOString() }, NOW);

  expect(() => control.claim(action.request_id, "withdraw-worker", NOW)).toThrow();
  expect(context.calls).toHaveLength(0);
  expect(memoriesAwaitingTaskWithdrawal(authority)).toHaveLength(1);
}, 120_000);
