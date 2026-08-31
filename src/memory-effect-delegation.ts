import { createHash, createPublicKey } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import type { MemoryEffectValidationOptions } from "./second-brain-effect-v2.js";

const digest = (value: unknown): string => `sha256:${createHash("sha256")
  .update(typeof value === "string" ? value : canonicalize(value)).digest("hex")}`;
function instant(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new JarvisError(code);
  return parsed;
}
function fingerprint(publicKeyPem: string, code: string): string {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new JarvisError(code);
    return `sha256:${createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex")}`;
  } catch (error) {
    if (error instanceof JarvisError) throw error;
    throw new JarvisError(code);
  }
}
export type RegisterMemoryEffectDelegationKey = {
  readonly key_id: string; readonly principal_id: "principal:owner";
  readonly public_key_pem: string; readonly valid_from: string; readonly valid_until: string;
};
export function registerMemoryEffectDelegationKey(authority: AuthorityDb,
  input: RegisterMemoryEffectDelegationKey, now = new Date()): string {
  const from = instant(input.valid_from, "MEMORY_EFFECT_KEY_INVALID");
  const until = instant(input.valid_until, "MEMORY_EFFECT_KEY_INVALID");
  if (!input.key_id || input.principal_id !== "principal:owner" || from >= until || until <= now.getTime()) {
    throw new JarvisError("MEMORY_EFFECT_KEY_INVALID");
  }
  const keyFingerprint = fingerprint(input.public_key_pem, "MEMORY_EFFECT_KEY_INVALID");
  const prior = authority.db.prepare(
    "SELECT * FROM memory_effect_delegation_keys WHERE key_id=? OR key_fingerprint=?",
  ).get(input.key_id, keyFingerprint) as Record<string, unknown> | undefined;
  if (prior !== undefined) {
    if (prior.key_id !== input.key_id || prior.principal_id !== input.principal_id
      || prior.public_key_pem !== input.public_key_pem || prior.valid_from !== input.valid_from
      || prior.valid_until !== input.valid_until) throw new JarvisError("MEMORY_EFFECT_KEY_REPLAY_CONFLICT");
    return keyFingerprint;
  }
  authority.db.prepare(
    `INSERT INTO memory_effect_delegation_keys(
      key_id,principal_id,algorithm,public_key_pem,key_fingerprint,state,valid_from,valid_until,created_at
     ) VALUES(?,?,?,?,?,'active',?,?,?)`,
  ).run(input.key_id, input.principal_id, "Ed25519", input.public_key_pem,
    keyFingerprint, input.valid_from, input.valid_until, now.toISOString());
  return keyFingerprint;
}
export function revokeMemoryEffectDelegationKey(authority: AuthorityDb, keyId: string): void {
  const changed = authority.db.prepare(
    "UPDATE memory_effect_delegation_keys SET state='revoked' WHERE key_id=? AND state='active'",
  ).run(keyId);
  if (changed.changes === 0 && authority.db.prepare(
    "SELECT 1 FROM memory_effect_delegation_keys WHERE key_id=? AND state='revoked'",
  ).get(keyId) === undefined) throw new JarvisError("MEMORY_EFFECT_KEY_NOT_FOUND");
}
export type RegisterExternalErasureKey = {
  readonly key_id: string; readonly owner_id_digest: string; readonly public_key_pem: string;
  readonly valid_from: string; readonly valid_until: string;
};
export function registerExternalErasureKey(authority: AuthorityDb,
  input: RegisterExternalErasureKey, now = new Date()): string {
  const from = instant(input.valid_from, "MEMORY_EXTERNAL_KEY_INVALID");
  const until = instant(input.valid_until, "MEMORY_EXTERNAL_KEY_INVALID");
  if (!input.key_id || !/^sha256:[0-9a-f]{64}$/.test(input.owner_id_digest)
    || from >= until || until <= now.getTime()) throw new JarvisError("MEMORY_EXTERNAL_KEY_INVALID");
  const keyFingerprint = fingerprint(input.public_key_pem, "MEMORY_EXTERNAL_KEY_INVALID");
  authority.db.prepare(
    `INSERT OR IGNORE INTO memory_external_erasure_keys(
      key_id,owner_id_digest,algorithm,public_key_pem,key_fingerprint,state,valid_from,valid_until,created_at
     ) VALUES(?,?,?,?,?,'active',?,?,?)`,
  ).run(input.key_id, input.owner_id_digest, "Ed25519", input.public_key_pem,
    keyFingerprint, input.valid_from, input.valid_until, now.toISOString());
  const prior = authority.db.prepare(
    "SELECT owner_id_digest,key_fingerprint FROM memory_external_erasure_keys WHERE key_id=?",
  ).get(input.key_id) as { readonly owner_id_digest: string; readonly key_fingerprint: string };
  if (prior.owner_id_digest !== input.owner_id_digest || prior.key_fingerprint !== keyFingerprint) {
    throw new JarvisError("MEMORY_EXTERNAL_KEY_REPLAY_CONFLICT");
  }
  return keyFingerprint;
}
export function memoryEffectValidationOptions(authority: AuthorityDb, now: Date,
  expectedProvider?: string): MemoryEffectValidationOptions {
  const at = now.toISOString();
  const delegation = authority.db.prepare(
    `SELECT key_id,public_key_pem FROM memory_effect_delegation_keys
     WHERE state='active' AND valid_from<=? AND valid_until>? ORDER BY key_id`,
  ).all(at, at) as Array<{ readonly key_id: string; readonly public_key_pem: string }>;
  const external = authority.db.prepare(
    `SELECT key_id,public_key_pem FROM memory_external_erasure_keys
     WHERE state='active' AND valid_from<=? AND valid_until>? ORDER BY key_id`,
  ).all(at, at) as Array<{ readonly key_id: string; readonly public_key_pem: string }>;
  return { now, delegationKeys: new Map(delegation.map(row => [row.key_id, row.public_key_pem])),
    externalReceiptKeys: new Map(external.map(row => [row.key_id, row.public_key_pem])),
    ...(expectedProvider === undefined ? {} : { expectedProvider }) };
}
export function revokeMemoryEffectDelegation(authority: AuthorityDb, input: {
  readonly delegation_id: string; readonly reason: string; readonly revoked_by: string;
  readonly revoked_at: string;
}, now = new Date()): string {
  if (!/^memdeleg:v1:[0-9a-f]{64}$/.test(input.delegation_id) || !input.reason
    || !input.revoked_by || instant(input.revoked_at, "MEMORY_EFFECT_REVOCATION_INVALID") > now.getTime()) {
    throw new JarvisError("MEMORY_EFFECT_REVOCATION_INVALID");
  }
  const body = { schema_version: 1, delegation_id: input.delegation_id,
    reason_digest: digest(input.reason), revoked_by: input.revoked_by, revoked_at: input.revoked_at };
  const payloadDigest = digest(body); const revocationId = `memdeleg-revoke:v1:${payloadDigest.slice(7)}`;
  authority.db.prepare(
    `INSERT OR IGNORE INTO memory_effect_delegation_revocations(
      revocation_id,delegation_id,reason_digest,revoked_by,revoked_at,payload_digest,created_at
     ) VALUES(?,?,?,?,?,?,?)`,
  ).run(revocationId, input.delegation_id, body.reason_digest, input.revoked_by,
    input.revoked_at, payloadDigest, now.toISOString());
  return revocationId;
}
export type RegisterMemoryProviderProofKey = {
  readonly key_id: string; readonly provider_instance_id: string;
  readonly provider_release_sha: string; readonly public_key_pem: string;
  readonly valid_from: string; readonly valid_until: string;
};
export function registerMemoryProviderProofKey(authority: AuthorityDb,
  input: RegisterMemoryProviderProofKey, now = new Date()): string {
  const from = instant(input.valid_from, "MEMORY_PROVIDER_KEY_INVALID");
  const until = instant(input.valid_until, "MEMORY_PROVIDER_KEY_INVALID");
  if (!input.key_id || !input.provider_instance_id || !/^[0-9a-f]{40}$/.test(input.provider_release_sha)
    || from >= until || until <= now.getTime()) throw new JarvisError("MEMORY_PROVIDER_KEY_INVALID");
  const keyFingerprint = fingerprint(input.public_key_pem, "MEMORY_PROVIDER_KEY_INVALID");
  authority.db.prepare(
    `INSERT OR IGNORE INTO memory_provider_proof_keys(
      key_id,provider_instance_id,provider_release_sha,algorithm,public_key_pem,key_fingerprint,state,
      valid_from,valid_until,created_at
     ) VALUES(?,?,?,?,?,?,'active',?,?,?)`,
  ).run(input.key_id, input.provider_instance_id, input.provider_release_sha, "Ed25519",
    input.public_key_pem, keyFingerprint, input.valid_from, input.valid_until, now.toISOString());
  const prior = authority.db.prepare(
    "SELECT key_fingerprint FROM memory_provider_proof_keys WHERE key_id=?",
  ).get(input.key_id) as { readonly key_fingerprint: string };
  if (prior.key_fingerprint !== keyFingerprint) throw new JarvisError("MEMORY_PROVIDER_KEY_REPLAY_CONFLICT");
  return keyFingerprint;
}
