import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { requireCorrectionCancellationResult, CORRECTION_CANCELLATION_RESULT_DOMAIN } from "../../src/memory-correction-cancellation-result.js";
const fixture = JSON.parse(readFileSync("contracts/cancellation-result-v1.json", "utf8"));
const options = { now:new Date(fixture.now), provider_keys:new Map<string,string>([[fixture.result.signing_key_id,fixture.provider_public_key]]) };
const key = createPrivateKey({ key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.from(Array.from({length:32},(_,i)=>i))]),format:"der",type:"pkcs8" });
function resign(value: Record<string,any>) {
  const {result_id,result_digest,signature,...body}=value;void result_id;void result_digest;void signature;
  const observed=`sha256:${createHash("sha256").update(CORRECTION_CANCELLATION_RESULT_DOMAIN).update(canonicalize(body)).digest("hex")}`;
  const unsigned={...body,result_id:`memcancel:result:v1:${observed.slice(7)}`,result_digest:observed};
  return {...unsigned,signature:sign(null,Buffer.from(CORRECTION_CANCELLATION_RESULT_DOMAIN+canonicalize(unsigned)),key).toString("base64url")};
}
it("verifies actual Python provider evidence with explicit local scope",()=>{
  const result=requireCorrectionCancellationResult(fixture.result,fixture.intent,options);
  expect(result.state).toBe("provider_local_suppressed");expect(result.alias_count).toBe(8);
  expect(Object.isFrozen(result)).toBe(true);
});
it.each([
  ["state","proved"],["disposition","all_managed_erased"],["original_request_id","other"],
  ["target_digest",`sha256:${"0".repeat(64)}`],["tombstone_sequence",2],["alias_count",7],
  ["completed_at","2099-01-01T00:00:00.000Z"],["activation_manifest_digest",`sha256:${"0".repeat(64)}`],
  ["result_generation_id",`sbgen:v1:${"0".repeat(64)}`],["schema_version",true],["content","unexpected body"],
])("rejects re-signed %s confusion",(field,value)=>{
  expect(()=>requireCorrectionCancellationResult(resign({...fixture.result,[field as string]:value}),fixture.intent,options)).toThrow();
});
it("rejects untrusted provider keys and corrupted signatures",()=>{
  expect(()=>requireCorrectionCancellationResult(fixture.result,fixture.intent,{...options,provider_keys:new Map()})).toThrow();
  expect(()=>requireCorrectionCancellationResult({...fixture.result,signature:"A".repeat(86)},fixture.intent,options)).toThrow();
});
