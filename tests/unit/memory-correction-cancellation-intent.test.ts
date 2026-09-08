import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { createCorrectionCancellationIntent, requireCorrectionCancellationIntent,
  CORRECTION_CANCELLATION_INTENT_DOMAIN, type CorrectionCancellationIntentOptions } from "../../src/memory-correction-cancellation-intent.js";
import { parseMemoryEffectWriteRequest, type MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";

const key = (start: number) => createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"),
  Buffer.from(Array.from({length:32}, (_, i)=>start+i))]), format:"der", type:"pkcs8" });
const historical = key(0); const current = key(32); const now = new Date("2026-09-08T00:00:00.000Z");
const original = JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")).vectors.correction.request as MemoryEffectWriteRequestV2;
const options: CorrectionCancellationIntentOptions = { provider_instance_id:"provider:fixture", now,
  historical_delegation_keys:new Map([["jarvis:fixture", createPublicKey(historical)]]),
  current_cancellation_keys:new Map([["jarvis:current", createPublicKey(current)]]) };
function intent() {
  return createCorrectionCancellationIntent(original, { candidate_id:`memcand:pos:v1:${"a".repeat(64)}`,
    suppression_event_digest:`sha256:${"b".repeat(64)}`, dispatch_fence:0, attempt_count:0, active_cursor:false },
  { issued_at:now.toISOString(), expires_at:"2026-09-08T00:05:00.000Z", nonce:"정정-취소", signing_key_id:"jarvis:current" }, current, options);
}
function resign(value: Record<string, any>) {
  const {intent_id, intent_digest, signature, ...body} = value;
  void intent_id; void intent_digest; void signature;
  const observed = `sha256:${createHash("sha256").update(CORRECTION_CANCELLATION_INTENT_DOMAIN).update(canonicalize(body)).digest("hex")}`;
  const unsigned = {...body, intent_id:`memcancel:intent:v1:${observed.slice(7)}`, intent_digest:observed};
  return {...unsigned, signature:sign(null, Buffer.from(CORRECTION_CANCELLATION_INTENT_DOMAIN+canonicalize(unsigned)), current).toString("base64url")};
}
it("validates expired original authority only as history, with current signed intent and no correction body", () => {
  const value = intent();
  expect(requireCorrectionCancellationIntent(value, options)).toEqual(value);
  expect(JSON.stringify(value)).not.toContain((original.payload as {content:string}).content);
  expect(Object.isFrozen(value.original_delegation.expected_prior)).toBe(true);
  expect(parseMemoryEffectWriteRequest(value, { now, delegationKeys:options.historical_delegation_keys })).toBeUndefined();
});
it.each(["current", "historical"])("requires explicit %s trust, independently", which => {
  const changed = {...options, [which === "current" ? "current_cancellation_keys" : "historical_delegation_keys"]:new Map()};
  expect(()=>requireCorrectionCancellationIntent(intent(), changed)).toThrow();
});
it.each([
  ["root plaintext", (v:Record<string,any>)=>{v.content="forbidden";}],
  ["nested plaintext", (v:Record<string,any>)=>{v.unsent_evidence.payload={content:"forbidden"};}],
  ["dispatch attempt", (v:Record<string,any>)=>{v.unsent_evidence.attempt_count=1;}],
  ["active cursor", (v:Record<string,any>)=>{v.unsent_evidence.active_cursor=true;}],
  ["boolean fence", (v:Record<string,any>)=>{v.unsent_evidence.dispatch_fence=false;}],
  ["target swap", (v:Record<string,any>)=>{v.target.page_id="wiki/other";}],
  ["prior swap", (v:Record<string,any>)=>{v.original_delegation.expected_prior.page_blob_oid="f".repeat(40);}],
  ["chain swap", (v:Record<string,any>)=>{v.tombstone.sequence=2;}],
  ["payload digest", (v:Record<string,any>)=>{v.tombstone.payload_digest=`sha256:${"f".repeat(64)}`;}],
  ["old signature", (v:Record<string,any>)=>{v.original_delegation.signature="a".repeat(86);}],
  ["overlong ttl", (v:Record<string,any>)=>{v.expires_at="2026-09-08T00:05:00.001Z";}],
  ["future intent", (v:Record<string,any>)=>{v.not_before="2026-09-08T00:00:00.001Z";}],
  ["purge claim", (v:Record<string,any>)=>{v.disposition="managed_erasure";}],
] as const)("rejects %s even with a valid current signer", (_name, mutate) => {
  const value = structuredClone(intent()); mutate(value);
  expect(()=>requireCorrectionCancellationIntent(resign(value), options)).toThrow();
});
it("rejects expiry, wrong provider and forged current signatures", () => {
  const value = intent();
  expect(()=>requireCorrectionCancellationIntent(value, {...options, now:new Date(value.expires_at)})).toThrow();
  expect(()=>requireCorrectionCancellationIntent(value, {...options, provider_instance_id:"provider:other"})).toThrow();
  expect(()=>requireCorrectionCancellationIntent({...value, signature:"a".repeat(86)}, options)).toThrow();
});
