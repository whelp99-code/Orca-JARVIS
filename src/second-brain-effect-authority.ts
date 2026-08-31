import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import { memoryEffectDigest, type MemoryEffectAcceptedV2, type MemoryEffectWriteRequestV2,
  type MemoryEffectValidationOptions } from "./second-brain-effect-v2.js";

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}
function instant(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new JarvisError(code);
  return parsed;
}
function keyFingerprint(publicKeyPem: string): string {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new JarvisError("MEMORY_EFFECT_KEY_INVALID");
    return `sha256:${createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex")}`;
  } catch (error) {
    if (error instanceof JarvisError) throw error;
    throw new JarvisError("MEMORY_EFFECT_KEY_INVALID");
  }
}

export type RegisterMemoryEffectDelegationKey = {
  readonly key_id: string; readonly principal_id: "principal:owner"; readonly public_key_pem: string;
  readonly valid_from: string; readonly valid_until: string;
};
export type RegisterExternalErasureKey = {
  readonly key_id: string; readonly owner_id_digest: string; readonly public_key_pem: string;
  readonly valid_from: string; readonly valid_until: string;
};
export function registerMemoryEffectDelegationKey(authority: AuthorityDb,
  input: RegisterMemoryEffectDelegationKey, now = new Date()): string {
  const from = instant(input.valid_from, "MEMORY_EFFECT_KEY_INVALID");
  const until = instant(input.valid_until, "MEMORY_EFFECT_KEY_INVALID");
  if (!input.key_id || input.principal_id !== "principal:owner" || from >= until || until <= now.getTime()) {
    throw new JarvisError("MEMORY_EFFECT_KEY_INVALID");
  }
  const fingerprint = keyFingerprint(input.public_key_pem); const at = now.toISOString();
  const prior = authority.db.prepare("SELECT * FROM memory_effect_delegation_keys WHERE key_id=? OR key_fingerprint=?")
    .get(input.key_id, fingerprint) as Record<string, unknown> | undefined;
  if (prior !== undefined) {
    if (prior.key_id !== input.key_id || prior.principal_id !== input.principal_id || prior.public_key_pem !== input.public_key_pem
      || prior.valid_from !== input.valid_from || prior.valid_until !== input.valid_until) throw new JarvisError("MEMORY_EFFECT_KEY_REPLAY_CONFLICT");
    return fingerprint;
  }
  authority.db.prepare(
    `INSERT INTO memory_effect_delegation_keys(
      key_id,principal_id,algorithm,public_key_pem,key_fingerprint,state,valid_from,valid_until,created_at
     ) VALUES(?,?,?,?,?,'active',?,?,?)`,
  ).run(input.key_id, input.principal_id, "Ed25519", input.public_key_pem, fingerprint,
    input.valid_from, input.valid_until, at);
  return fingerprint;
}
export function revokeMemoryEffectDelegationKey(authority: AuthorityDb, keyId: string): void {
  if (!keyId) throw new JarvisError("MEMORY_EFFECT_KEY_INVALID");
  const changed = authority.db.prepare(
    "UPDATE memory_effect_delegation_keys SET state='revoked' WHERE key_id=? AND state='active'",
  ).run(keyId);
  if (changed.changes === 0) {
    const prior = authority.db.prepare("SELECT state FROM memory_effect_delegation_keys WHERE key_id=?")
      .get(keyId) as { state: string } | undefined;
    if (prior?.state !== "revoked") throw new JarvisError("MEMORY_EFFECT_KEY_NOT_FOUND");
  }
}

export function registerExternalErasureKey(authority: AuthorityDb,
  input: RegisterExternalErasureKey, now = new Date()): string {
  const from = instant(input.valid_from, "MEMORY_EXTERNAL_KEY_INVALID");
  const until = instant(input.valid_until, "MEMORY_EXTERNAL_KEY_INVALID");
  if (!input.key_id || !/^sha256:[0-9a-f]{64}$/.test(input.owner_id_digest) || from >= until || until <= now.getTime()) {
    throw new JarvisError("MEMORY_EXTERNAL_KEY_INVALID");
  }
  const fingerprint = keyFingerprint(input.public_key_pem); const at = now.toISOString();
  const prior = authority.db.prepare("SELECT * FROM memory_external_erasure_keys WHERE key_id=? OR key_fingerprint=?")
    .get(input.key_id, fingerprint) as Record<string, unknown> | undefined;
  if (prior !== undefined) {
    if (prior.key_id !== input.key_id || prior.owner_id_digest !== input.owner_id_digest
      || prior.public_key_pem !== input.public_key_pem || prior.valid_from !== input.valid_from
      || prior.valid_until !== input.valid_until) throw new JarvisError("MEMORY_EXTERNAL_KEY_REPLAY_CONFLICT");
    return fingerprint;
  }
  authority.db.prepare(
    `INSERT INTO memory_external_erasure_keys(
      key_id,owner_id_digest,algorithm,public_key_pem,key_fingerprint,state,valid_from,valid_until,created_at
     ) VALUES(?,?,?,?,?,'active',?,?,?)`,
  ).run(input.key_id, input.owner_id_digest, "Ed25519", input.public_key_pem, fingerprint,
    input.valid_from, input.valid_until, at);
  return fingerprint;
}
export function memoryEffectValidationOptions(authority: AuthorityDb, now: Date,
  expectedProvider?: string): MemoryEffectValidationOptions {
  const at = now.toISOString();
  const delegation = authority.db.prepare(
    `SELECT key_id,public_key_pem FROM memory_effect_delegation_keys
     WHERE state='active' AND valid_from<=? AND valid_until>? ORDER BY key_id`,
  ).all(at, at) as Array<{ key_id: string; public_key_pem: string }>;
  const external = authority.db.prepare(
    `SELECT key_id,public_key_pem FROM memory_external_erasure_keys
     WHERE state='active' AND valid_from<=? AND valid_until>? ORDER BY key_id`,
  ).all(at, at) as Array<{ key_id: string; public_key_pem: string }>;
  return {
    now, delegationKeys: new Map(delegation.map(row => [row.key_id, row.public_key_pem])),
    externalReceiptKeys: new Map(external.map(row => [row.key_id, row.public_key_pem])),
    ...(expectedProvider === undefined ? {} : { expectedProvider }),
  };
}

export type RevokeMemoryEffectDelegation = {
  readonly delegation_id: string; readonly reason: string; readonly revoked_by: string; readonly revoked_at: string;
};
export function revokeMemoryEffectDelegation(authority: AuthorityDb,
  input: RevokeMemoryEffectDelegation, now = new Date()): string {
  const revoked = instant(input.revoked_at, "MEMORY_EFFECT_REVOCATION_INVALID");
  if (!/^memdeleg:v1:[0-9a-f]{64}$/.test(input.delegation_id) || !input.reason || !input.revoked_by
    || revoked > now.getTime()) throw new JarvisError("MEMORY_EFFECT_REVOCATION_INVALID");
  const normalized = { schema_version: 1, delegation_id: input.delegation_id, reason: input.reason,
    revoked_by: input.revoked_by, revoked_at: input.revoked_at };
  const payloadDigest = memoryEffectDigest("delegation_revocation", normalized);
  const revocationId = `memdeleg-revoke:v1:${payloadDigest.slice(7)}`;
  const prior = authority.db.prepare("SELECT payload_digest FROM memory_effect_delegation_revocations WHERE delegation_id=?")
    .get(input.delegation_id) as { payload_digest: string } | undefined;
  if (prior !== undefined) {
    if (prior.payload_digest !== payloadDigest) throw new JarvisError("MEMORY_EFFECT_REVOCATION_REPLAY_CONFLICT");
    return revocationId;
  }
  authority.db.prepare(
    `INSERT INTO memory_effect_delegation_revocations(
      revocation_id,delegation_id,reason,revoked_by,revoked_at,payload_digest,created_at
     ) VALUES(?,?,?,?,?,?,?)`,
  ).run(revocationId, input.delegation_id, input.reason, input.revoked_by, input.revoked_at,
    payloadDigest, now.toISOString());
  return revocationId;
}

function existingRequest(authority: AuthorityDb, request: MemoryEffectWriteRequestV2): Record<string, unknown> | undefined {
  return authority.db.prepare(
    `SELECT * FROM memory_effect_requests WHERE request_id=? OR request_digest=? OR idempotency_key=?
      OR envelope_digest=? OR delegation_id=?`,
  ).get(request.request_id, request.request_digest, request.idempotency_key,
    request.envelope_digest, request.delegation.delegation_id) as Record<string, unknown> | undefined;
}
function exactExisting(row: Record<string, unknown>, request: MemoryEffectWriteRequestV2): boolean {
  return row.request_id === request.request_id && row.request_digest === request.request_digest
    && row.idempotency_key === request.idempotency_key && row.envelope_digest === request.envelope_digest
    && row.delegation_id === request.delegation.delegation_id && row.request_json === canonicalize(request);
}
function commandAuthority(authority: AuthorityDb, request: MemoryEffectWriteRequestV2, now: Date):
  { request_id: string; receipt_id: string } | undefined {
  const expectedAction = request.operation === "correct" ? "memory.correct"
    : request.operation === "forget" ? "memory.forget" : "memory.export";
  const minimum = request.operation === "forget" ? 4 : 3;
  const rows = authority.db.prepare(
    `SELECT r.request_id,x.receipt_id,r.args_json,r.target_json,r.action,r.action_level,r.expires_at,
      r.command_digest,a.command_digest AS receipt_digest,a.expires_at AS receipt_expires
     FROM control_command_requests r
     JOIN control_command_redemptions x ON x.request_id=r.request_id AND x.lease_fence=r.lease_fence
     JOIN control_command_receipts a ON a.receipt_id=x.receipt_id AND a.request_id=r.request_id
     LEFT JOIN control_command_revocations v ON v.request_id=r.request_id OR v.receipt_id=x.receipt_id
     WHERE r.state='claimed' AND r.action=? AND r.action_level>=? AND a.decision='approve'
       AND v.request_id IS NULL AND json_extract(r.args_json,'$.request.request_id')=?`,
  ).all(expectedAction, minimum, request.request_id) as Array<Record<string, unknown>>;
  const expectedArgs = canonicalize({ schema_version: 2, request });
  for (const row of rows) {
    if (row.args_json === expectedArgs && row.command_digest === row.receipt_digest
      && Date.parse(String(row.expires_at)) > now.getTime() && Date.parse(String(row.receipt_expires)) > now.getTime()) {
      return { request_id: String(row.request_id), receipt_id: String(row.receipt_id) };
    }
  }
  return undefined;
}
function delegationAvailable(authority: AuthorityDb, request: MemoryEffectWriteRequestV2, now: Date): boolean {
  const row = authority.db.prepare(
    `SELECT k.state,k.valid_from,k.valid_until,v.delegation_id
     FROM memory_effect_delegation_keys k
     LEFT JOIN memory_effect_delegation_revocations v ON v.delegation_id=?
     WHERE k.key_id=?`,
  ).get(request.delegation.delegation_id, request.delegation.signing_key_id) as Record<string, unknown> | undefined;
  return row !== undefined && row.state === "active" && row.delegation_id === null
    && Date.parse(String(row.valid_from)) <= now.getTime() && Date.parse(String(row.valid_until)) > now.getTime()
    && Date.parse(request.delegation.not_before) <= now.getTime() && Date.parse(request.delegation.expires_at) > now.getTime();
}
export function hasMemoryEffectWriteAuthority(authority: AuthorityDb,
  request: MemoryEffectWriteRequestV2, now: Date): boolean {
  if (!delegationAvailable(authority, request, now)) return false;
  const existing = existingRequest(authority, request);
  if (existing !== undefined) return exactExisting(existing, request)
    && authority.db.prepare("SELECT 1 FROM memory_effect_delegation_uses WHERE delegation_id=? AND request_id=?")
      .get(request.delegation.delegation_id, request.request_id) !== undefined;
  return commandAuthority(authority, request, now) !== undefined;
}

export function prepareMemoryEffectDispatch(authority: AuthorityDb,
  request: MemoryEffectWriteRequestV2, now: Date): { readonly replayed: boolean } {
  if (!delegationAvailable(authority, request, now)) throw new JarvisError("MEMORY_EFFECT_DELEGATION_INVALID");
  const prior = existingRequest(authority, request);
  if (prior !== undefined) {
    if (!exactExisting(prior, request)) throw new JarvisError("MEMORY_EFFECT_REPLAY_CONFLICT");
    const use = authority.db.prepare("SELECT 1 FROM memory_effect_delegation_uses WHERE delegation_id=? AND request_id=?")
      .get(request.delegation.delegation_id, request.request_id);
    if (use === undefined) throw new JarvisError("MEMORY_EFFECT_INTEGRITY_FAILURE");
    return { replayed: true };
  }
  const command = commandAuthority(authority, request, now);
  if (command === undefined) throw new JarvisError("MEMORY_EFFECT_AUTHORITY_INVALID");
  const at = now.toISOString();
  authority.db.transaction(() => {
    authority.db.prepare(
      `INSERT INTO memory_effect_requests(
        request_id,request_digest,idempotency_key,envelope_digest,provider_instance_id,lane,lane_id,operation,
        target_manifest_digest,scope_digest,delegation_id,request_json,control_request_id,control_receipt_id,state,
        created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`,
    ).run(request.request_id, request.request_digest, request.idempotency_key, request.envelope_digest,
      request.provider_instance_id, request.lane, request.lane_id, request.operation, request.target_manifest_digest,
      request.scope_digest, request.delegation.delegation_id, canonicalize(request), command.request_id,
      command.receipt_id, at, at);
    const delegation = request.delegation;
    authority.db.prepare(
      `INSERT INTO memory_effect_delegations(
        delegation_id,delegation_digest,request_id,signing_key_id,nonce,payload_json,signature,issued_at,
        not_before,expires_at,max_uses,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(delegation.delegation_id, delegation.delegation_digest, request.request_id, delegation.signing_key_id,
      delegation.nonce, canonicalize(delegation), delegation.signature, delegation.issued_at, delegation.not_before,
      delegation.expires_at, delegation.max_uses, at);
    authority.db.prepare(
      "INSERT INTO memory_effect_delegation_uses(delegation_id,request_id,control_request_id,used_at) VALUES(?,?,?,?)",
    ).run(delegation.delegation_id, request.request_id, command.request_id, at);
    request.targets.forEach((target, ordinal) => {
      const targetJson = canonicalize(target);
      authority.db.prepare(
        `INSERT OR IGNORE INTO memory_resolved_targets(
          target_id,target_digest,provider_instance_id,generation_id,generation_manifest_digest,page_id,page_blob_oid,
          page_content_digest,source_identity_full,content_identity_full,citation_identity_full,subject_digest,sensitivity,
          source_owner_class,source_owner_id_digest,target_json,resolved_at,expires_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(target.target_id, target.target_digest, target.provider_instance_id, target.generation_id,
        target.generation_manifest_digest, target.page_id, target.page_blob_oid, target.page_content_digest,
        target.source_identity_full, target.content_identity_full, target.citation_identity_full, target.subject_digest,
        target.sensitivity, target.source_owner_class, target.source_owner_id_digest, targetJson,
        target.resolved_at, target.expires_at);
      const stored = authority.db.prepare("SELECT target_json FROM memory_resolved_targets WHERE target_id=?")
        .get(target.target_id) as { target_json: string } | undefined;
      if (stored?.target_json !== targetJson) throw new JarvisError("MEMORY_EFFECT_TARGET_REPLAY_CONFLICT");
      authority.db.prepare("INSERT INTO memory_effect_request_targets(request_id,target_id,ordinal) VALUES(?,?,?)")
        .run(request.request_id, target.target_id, ordinal);
    });
  }).immediate();
  return { replayed: false };
}

function appendProgress(authority: AuthorityDb, requestId: string, phase: string,
  observation: unknown, observedAt: string): void {
  const sequence = Number((authority.db.prepare(
    "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM memory_effect_progress WHERE request_id=?",
  ).get(requestId) as { sequence: number }).sequence);
  const observationJson = canonicalize(observation); const observationDigest = digest(observation);
  const progressId = `memprog:v1:${digest({ request_id: requestId, sequence, phase, observation_digest: observationDigest, observed_at: observedAt }).slice(7)}`;
  authority.db.prepare(
    `INSERT INTO memory_effect_progress(
      progress_id,request_id,sequence,phase,observation_json,observation_digest,observed_at,created_at
     ) VALUES(?,?,?,?,?,?,?,?)`,
  ).run(progressId, requestId, sequence, phase, observationJson, observationDigest, observedAt, observedAt);
}
export function recordMemoryEffectAccepted(authority: AuthorityDb, request: MemoryEffectWriteRequestV2,
  result: MemoryEffectAcceptedV2, now: Date): void {
  if (result.request_id !== request.request_id || result.request_digest !== request.request_digest
    || result.idempotency_key !== request.idempotency_key || result.envelope_digest !== request.envelope_digest
    || result.lane !== request.lane || result.operation !== request.operation
    || result.provider_instance_id !== request.provider_instance_id
    || result.tombstone_sequence !== request.tombstone_high_water.sequence
    || result.tombstone_set_root !== request.tombstone_high_water.set_root) throw new JarvisError("MEMORY_EFFECT_RESULT_INVALID");
  const at = now.toISOString(); const resultJson = canonicalize(result); const resultDigest = digest(result);
  authority.db.transaction(() => {
    const row = authority.db.prepare("SELECT state,provider_result_json FROM memory_effect_requests WHERE request_id=?")
      .get(request.request_id) as { state: string; provider_result_json: string | null } | undefined;
    if (row === undefined) throw new JarvisError("MEMORY_EFFECT_INTEGRITY_FAILURE");
    if (row.provider_result_json !== null) {
      const prior = JSON.parse(row.provider_result_json) as Record<string, unknown>;
      if (canonicalize({ ...prior, replayed: false }) !== canonicalize({ ...result, replayed: false })) {
        throw new JarvisError("MEMORY_EFFECT_RESULT_REPLAY_CONFLICT");
      }
      return;
    }
    const changed = authority.db.prepare(
      `UPDATE memory_effect_requests SET state='accepted',provider_result_json=?,provider_result_digest=?,
       failure_code=NULL,updated_at=? WHERE request_id=? AND state IN ('prepared','uncertain')`,
    ).run(resultJson, resultDigest, at, request.request_id);
    if (changed.changes !== 1) throw new JarvisError("MEMORY_EFFECT_TRANSITION_INVALID");
    appendProgress(authority, request.request_id, "accepted", result, result.accepted_at);
    const high = request.tombstone_high_water;
    const latest = authority.db.prepare(
      `SELECT sequence,set_root FROM memory_tombstone_watermarks WHERE provider_instance_id=?
       ORDER BY sequence DESC LIMIT 1`,
    ).get(request.provider_instance_id) as { sequence: number; set_root: string } | undefined;
    if (latest === undefined || high.sequence > latest.sequence) {
      authority.db.prepare(
        `INSERT INTO memory_tombstone_watermarks(provider_instance_id,sequence,set_root,request_id,observed_at)
         VALUES(?,?,?,?,?)`,
      ).run(request.provider_instance_id, high.sequence, high.set_root, request.request_id, result.accepted_at);
    } else if (high.sequence !== latest.sequence || high.set_root !== latest.set_root) {
      throw new JarvisError("MEMORY_EFFECT_TOMBSTONE_STALE");
    }
  }).immediate();
}
export function recordMemoryEffectDispatchFailure(authority: AuthorityDb, requestId: string,
  state: "failed" | "uncertain", code: string, now: Date): void {
  const at = now.toISOString();
  authority.db.transaction(() => {
    const changed = authority.db.prepare(
      "UPDATE memory_effect_requests SET state=?,failure_code=?,updated_at=? WHERE request_id=? AND state='prepared'",
    ).run(state, code, at, requestId);
    if (changed.changes === 1) appendProgress(authority, requestId, state, { code }, at);
  }).immediate();
}

export type RegisterMemoryProviderProofKey = {
  readonly key_id: string; readonly provider_instance_id: string; readonly provider_release_sha: string;
  readonly public_key_pem: string; readonly valid_from: string; readonly valid_until: string;
};
export function registerMemoryProviderProofKey(authority: AuthorityDb,
  input: RegisterMemoryProviderProofKey, now = new Date()): string {
  const from = instant(input.valid_from, "MEMORY_PROVIDER_KEY_INVALID");
  const until = instant(input.valid_until, "MEMORY_PROVIDER_KEY_INVALID");
  if (!input.key_id || !input.provider_instance_id || !/^[0-9a-f]{40}$/.test(input.provider_release_sha)
    || from >= until || until <= now.getTime()) throw new JarvisError("MEMORY_PROVIDER_KEY_INVALID");
  const fingerprint = keyFingerprint(input.public_key_pem); const at = now.toISOString();
  const prior = authority.db.prepare("SELECT * FROM memory_provider_proof_keys WHERE key_id=? OR key_fingerprint=?")
    .get(input.key_id, fingerprint) as Record<string, unknown> | undefined;
  if (prior !== undefined) {
    if (prior.key_id !== input.key_id || prior.provider_instance_id !== input.provider_instance_id
      || prior.provider_release_sha !== input.provider_release_sha || prior.public_key_pem !== input.public_key_pem
      || prior.valid_from !== input.valid_from || prior.valid_until !== input.valid_until) {
      throw new JarvisError("MEMORY_PROVIDER_KEY_REPLAY_CONFLICT");
    }
    return fingerprint;
  }
  authority.db.prepare(
    `INSERT INTO memory_provider_proof_keys(
      key_id,provider_instance_id,provider_release_sha,algorithm,public_key_pem,key_fingerprint,state,
      valid_from,valid_until,created_at
     ) VALUES(?,?,?,?,?,?,'active',?,?,?)`,
  ).run(input.key_id, input.provider_instance_id, input.provider_release_sha, "Ed25519", input.public_key_pem,
    fingerprint, input.valid_from, input.valid_until, at);
  return fingerprint;
}

function providerProof(authority: AuthorityDb, request: MemoryEffectWriteRequestV2,
  value: unknown, now: Date): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new JarvisError("MEMORY_PROVIDER_PROOF_INVALID");
  const proof = value as Record<string, unknown>;
  const required = ["schema_version", "proof_id", "proof_digest", "proof_type", "provider_instance_id",
    "provider_release_sha", "provider_signing_key_id", "request_id", "request_digest", "envelope_digest",
    "idempotency_key", "delegation_id", "delegation_digest", "lane_id", "operation", "payload_digest",
    "target_manifest_digest", "scope_digest", "base_generation_id", "base_head", "base_tree",
    "result_generation_id", "result_head", "result_tree", "tombstone_sequence", "tombstone_previous_root",
    "tombstone_set_root", "activation_journal_digest", "reader_drain_digest", "predecessor_disposal_digest",
    "backup_disposal_digest", "export_disposal_digest", "surface_manifest_digest", "artifact_manifest_digest",
    "export_manifest_digest", "claimed_at", "applied_at", "completed_at", "signature"];
  if (Object.keys(proof).sort().join("\0") !== required.sort().join("\0") || proof.schema_version !== 1
    || proof.request_id !== request.request_id || proof.request_digest !== request.request_digest
    || proof.envelope_digest !== request.envelope_digest || proof.idempotency_key !== request.idempotency_key
    || proof.delegation_id !== request.delegation.delegation_id
    || proof.delegation_digest !== request.delegation.delegation_digest || proof.lane_id !== request.lane_id
    || proof.operation !== request.operation || proof.target_manifest_digest !== request.target_manifest_digest
    || proof.scope_digest !== request.scope_digest || proof.provider_instance_id !== request.provider_instance_id
    || proof.tombstone_sequence !== request.tombstone_high_water.sequence
    || proof.tombstone_set_root !== request.tombstone_high_water.set_root) throw new JarvisError("MEMORY_PROVIDER_PROOF_INVALID");
  const unsignedDigest = Object.fromEntries(Object.entries(proof)
    .filter(([key]) => !["proof_id", "proof_digest", "signature"].includes(key)));
  const observed = `sha256:${createHash("sha256").update("second-brain/memory-disposition-proof/v1\0")
    .update(canonicalize(unsignedDigest)).digest("hex")}`;
  if (proof.proof_digest !== observed || proof.proof_id !== `sbproof:v1:${observed.slice(7)}`
    || typeof proof.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)) {
    throw new JarvisError("MEMORY_PROVIDER_PROOF_INVALID");
  }
  const key = authority.db.prepare(
    `SELECT public_key_pem FROM memory_provider_proof_keys WHERE key_id=? AND provider_instance_id=?
      AND provider_release_sha=? AND state='active' AND valid_from<=? AND valid_until>?`,
  ).get(proof.provider_signing_key_id, proof.provider_instance_id, proof.provider_release_sha,
    now.toISOString(), now.toISOString()) as { public_key_pem: string } | undefined;
  if (key === undefined) throw new JarvisError("MEMORY_PROVIDER_PROOF_KEY_INVALID");
  const unsigned = Object.fromEntries(Object.entries(proof).filter(([name]) => name !== "signature"));
  try {
    if (!verify(null, Buffer.from(`second-brain/memory-disposition-proof/v1\0${canonicalize(unsigned)}`),
      createPublicKey(key.public_key_pem), Buffer.from(proof.signature, "base64url"))) {
      throw new JarvisError("MEMORY_PROVIDER_PROOF_SIGNATURE_INVALID");
    }
  } catch (error) {
    if (error instanceof JarvisError) throw error;
    throw new JarvisError("MEMORY_PROVIDER_PROOF_SIGNATURE_INVALID");
  }
  const claimed = instant(String(proof.claimed_at), "MEMORY_PROVIDER_PROOF_INVALID");
  const applied = instant(String(proof.applied_at), "MEMORY_PROVIDER_PROOF_INVALID");
  const completed = instant(String(proof.completed_at), "MEMORY_PROVIDER_PROOF_INVALID");
  if (claimed > applied || applied > completed || completed > now.getTime()) throw new JarvisError("MEMORY_PROVIDER_PROOF_INVALID");
  const expectedType = request.operation === "correct" ? "correction" : request.operation === "forget" ? "forget" : "export";
  if (proof.proof_type !== expectedType) throw new JarvisError("MEMORY_PROVIDER_PROOF_INVALID");
  if (request.operation === "export") {
    if (proof.export_manifest_digest === null || proof.base_generation_id !== proof.result_generation_id
      || proof.base_head !== proof.result_head || proof.base_tree !== proof.result_tree
      || proof.activation_journal_digest !== null) throw new JarvisError("MEMORY_PROVIDER_PROOF_INVALID");
  } else if (proof.activation_journal_digest === null || proof.reader_drain_digest === null
    || proof.predecessor_disposal_digest === null || proof.backup_disposal_digest === null
    || proof.export_disposal_digest === null || proof.export_manifest_digest !== null) {
    throw new JarvisError("MEMORY_PROVIDER_PROOF_INVALID");
  }
  return proof;
}
function erasureEvent(authority: AuthorityDb, request: MemoryEffectWriteRequestV2, eventType: string,
  proof: Record<string, unknown>, at: string, predecessorDisposed: boolean | null): void {
  const body = { request_id: request.request_id, event_type: eventType, proof_digest: proof.proof_digest };
  const eventDigest = digest(body); const eventId = `memerase:v1:${eventDigest.slice(7)}`;
  authority.db.prepare(
    `INSERT OR IGNORE INTO memory_erasure_ledger(
      erasure_event_id,request_id,event_type,generation_id,artifact_digest,proof_json,proof_digest,
      predecessor_disposed,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(eventId, request.request_id, eventType, proof.result_generation_id,
    eventType === "export_manifest" ? proof.export_manifest_digest : proof.surface_manifest_digest,
    canonicalize(proof), eventDigest, predecessorDisposed === null ? null : predecessorDisposed ? 1 : 0, at);
}
export function recordMemoryEffectProviderStatus(authority: AuthorityDb, requestId: string,
  status: Readonly<Record<string, unknown>>, now: Date): void {
  const row = authority.db.prepare("SELECT request_json,state FROM memory_effect_requests WHERE request_id=?")
    .get(requestId) as { request_json: string; state: string } | undefined;
  if (row === undefined) throw new JarvisError("MEMORY_EFFECT_REQUEST_NOT_FOUND");
  const request = JSON.parse(row.request_json) as MemoryEffectWriteRequestV2;
  if (status.request_id !== requestId || status.request_digest !== request.request_digest
    || status.envelope_digest !== request.envelope_digest || status.idempotency_key !== request.idempotency_key
    || status.lane_id !== request.lane_id || status.operation !== request.operation
    || status.tombstone_sequence !== request.tombstone_high_water.sequence
    || status.tombstone_set_root !== request.tombstone_high_water.set_root) throw new JarvisError("MEMORY_EFFECT_STATUS_INVALID");
  const providerState = String(status.state); const phase = status.phase === null || status.phase === undefined
    ? providerState : String(status.phase); const allowedPhases = new Set(["claimed", "staging", "sealed", "switch_intent", "activated", "disposing", "proved"]);
  const at = now.toISOString();
  authority.db.transaction(() => {
    const latest = authority.db.prepare(
      "SELECT observation_json FROM memory_effect_progress WHERE request_id=? ORDER BY sequence DESC LIMIT 1",
    ).get(requestId) as { observation_json: string } | undefined;
    if (latest?.observation_json !== canonicalize(status)) {
      appendProgress(authority, requestId, providerState === "proved" ? "proved"
        : providerState === "pending" ? "accepted"
          : providerState === "failed" || providerState === "expired" || providerState === "reapproval_required" ? "failed"
            : allowedPhases.has(phase) ? phase : "uncertain", status, at);
    }
    const current = String((authority.db.prepare("SELECT state FROM memory_effect_requests WHERE request_id=?")
      .get(requestId) as { state: string }).state);
    if (providerState === "pending") {
      if (["prepared", "uncertain"].includes(current)) authority.db.prepare(
        "UPDATE memory_effect_requests SET state='accepted',failure_code=NULL,updated_at=? WHERE request_id=?",
      ).run(at, requestId);
      const high = request.tombstone_high_water;
      const latest = authority.db.prepare(
        `SELECT sequence,set_root FROM memory_tombstone_watermarks WHERE provider_instance_id=?
         ORDER BY sequence DESC LIMIT 1`,
      ).get(request.provider_instance_id) as { sequence: number; set_root: string } | undefined;
      if (latest === undefined || high.sequence > latest.sequence) authority.db.prepare(
        `INSERT INTO memory_tombstone_watermarks(provider_instance_id,sequence,set_root,request_id,observed_at)
         VALUES(?,?,?,?,?)`,
      ).run(request.provider_instance_id, high.sequence, high.set_root, request.request_id, at);
      else if (latest.sequence !== high.sequence || latest.set_root !== high.set_root) {
        throw new JarvisError("MEMORY_EFFECT_TOMBSTONE_STALE");
      }
      return;
    }
    if (["failed", "expired", "reapproval_required"].includes(providerState)) {
      if (!["failed", "completed"].includes(current)) authority.db.prepare(
        "UPDATE memory_effect_requests SET state='failed',failure_code=?,updated_at=? WHERE request_id=?",
      ).run(`PROVIDER_${providerState.toUpperCase()}`, at, requestId);
      return;
    }
    if (providerState === "processing" && current === "accepted") authority.db.prepare(
      "UPDATE memory_effect_requests SET state='applying',updated_at=? WHERE request_id=?",
    ).run(at, requestId);
    if (providerState !== "proved") return;
    const proof = providerProof(authority, request, status.proof, now);
    const beforeComplete = String((authority.db.prepare("SELECT state FROM memory_effect_requests WHERE request_id=?")
      .get(requestId) as { state: string }).state);
    if (beforeComplete === "accepted" || beforeComplete === "uncertain") authority.db.prepare(
      "UPDATE memory_effect_requests SET state='applying',updated_at=? WHERE request_id=?",
    ).run(at, requestId);
    if (request.operation === "export") {
      erasureEvent(authority, request, "export_manifest", proof, at, null);
      erasureEvent(authority, request, "export_artifact", proof, at, null);
    } else {
      erasureEvent(authority, request, "logical_disposition", proof, at, null);
      erasureEvent(authority, request, "generation_rewrite", proof, at, null);
      erasureEvent(authority, request, "reader_drain", proof, at, null);
      erasureEvent(authority, request, "predecessor_disposal", proof, at, true);
      erasureEvent(authority, request, "physical_absence", proof, at, true);
      if (request.operation === "forget") {
        erasureEvent(authority, request, "deletion_proof", proof, at, true);
        erasureEvent(authority, request, "reingress_block", proof, at, true);
      }
    }
    const changed = authority.db.prepare(
      "UPDATE memory_effect_requests SET state='completed',completed_at=?,updated_at=? WHERE request_id=? AND state='applying'",
    ).run(String(proof.completed_at), at, requestId);
    if (changed.changes !== 1 && beforeComplete !== "completed") throw new JarvisError("MEMORY_EFFECT_TRANSITION_INVALID");
  }).immediate();
}
