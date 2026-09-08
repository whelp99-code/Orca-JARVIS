import { createHash, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalize } from "../../src/canonical.js";
import { MemoryCorrectionCancellationIssuer } from "../../src/memory-correction-cancellation-issuer.js";
import { registerMemoryProviderProofKey } from "../../src/memory-effect-delegation.js";
import { CORRECTION_CANCELLATION_RESULT_DOMAIN } from "../../src/memory-correction-cancellation-result.js";
import { cancellationDatabaseFixture } from "./memory-cancellation-db.js";

export async function cancellationResultFixture() {
  const f = await cancellationDatabaseFixture();
  const intent = new MemoryCorrectionCancellationIssuer(f.db, f.runtime.clock)
    .issue(f.record.correction_id, f.runtime.signing_key_id, f.runtime.private_key);
  const fixture = JSON.parse(readFileSync("contracts/cancellation-result-v1.json", "utf8"));
  const { result_id: _id, result_digest: _digest, signature: _signature, ...base } = fixture.result;
  void _id; void _digest; void _signature;
  const completed = new Date(f.runtime.clock().getTime() + 1_000);
  const body = { ...base, provider_instance_id: intent.provider_instance_id, provider_release_sha: "a".repeat(40),
    signing_key_id: "provider:fixture", intent_id: intent.intent_id, intent_digest: intent.intent_digest,
    original_request_id: intent.original_delegation.request_id, original_envelope_digest: intent.original_envelope_digest,
    original_lane_id: intent.original_delegation.lane_id, target_digest: intent.target.target_digest,
    target_manifest_digest: intent.original_delegation.target_manifest_digest, scope_digest: intent.original_delegation.scope_digest,
    base_generation_id: intent.target.generation_id, result_generation_id: `sbgen:v1:${"f".repeat(64)}`,
    result_generation_manifest_digest: `sha256:${"f".repeat(64)}`, activation_manifest_digest: `sha256:${"f".repeat(64)}`,
    tombstone_sequence: intent.tombstone.sequence, tombstone_previous_root: intent.tombstone.previous_root,
    tombstone_set_root: intent.tombstone.set_root, accepted_at: intent.not_before, completed_at: completed.toISOString() };
  function signed(value: Record<string, unknown>) {
    const digest = `sha256:${createHash("sha256").update(CORRECTION_CANCELLATION_RESULT_DOMAIN).update(canonicalize(value)).digest("hex")}`;
    const unsigned = { ...value, result_id: `memcancel:result:v1:${digest.slice(7)}`, result_digest: digest };
    return { ...unsigned, signature: sign(null, Buffer.from(CORRECTION_CANCELLATION_RESULT_DOMAIN + canonicalize(unsigned)), f.runtime.private_key).toString("base64url") };
  }
  registerMemoryProviderProofKey(f.db, { key_id: "provider:fixture", provider_instance_id: intent.provider_instance_id,
    provider_release_sha: "a".repeat(40), public_key_pem: createPublicKey(f.runtime.private_key).export({ format: "pem", type: "spki" }).toString(),
    valid_from: intent.issued_at, valid_until: "2026-08-29T00:00:00.000Z" }, f.runtime.clock());
  f.setTime(new Date(completed.getTime() + 1_000));
  return { ...f, intent, result: signed(body), signed, body };
}
