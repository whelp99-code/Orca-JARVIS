import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalize } from "./canonical.js";
import {
  closedObject,
  closeoutDigest,
  closeoutMember,
  closeoutText,
  invalidCloseout,
} from "./evening-closeout-parse-values.js";
import type {
  CloseoutEnvelope,
  CloseoutSigningIdentity,
  TrustedCloseoutKey,
} from "./evening-closeout-types.js";

export const EVENING_CLOSEOUT_DOMAIN = "orca-jarvis/evening-closeout/v1\0";
export const EVENING_VERIFICATION_DOMAIN = "orca-jarvis/evening-closeout-verification/v1\0";
export const closeoutHash = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
export const closeoutSigningBytes = (domain: string, value: unknown): Uint8Array =>
  Buffer.from(`${domain}${canonicalize(value)}`, "utf8");
function canonicalSpki(value: unknown): string {
  const encoded = closeoutText(value, 59);
  if (!/^[A-Za-z0-9_-]{59}$/.test(encoded)) return invalidCloseout();
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length !== 44 || bytes.toString("base64url") !== encoded) return invalidCloseout();
  try {
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    const exported = key.export({ type: "spki", format: "der" });
    if (key.asymmetricKeyType !== "ed25519" || !Buffer.from(exported).equals(bytes)) return invalidCloseout();
    return encoded;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return invalidCloseout();
  }
}
function keyId(value: unknown): string {
  const parsed = closeoutText(value, 64);
  return /^[a-z][a-z0-9-]{2,63}$/.test(parsed) ? parsed : invalidCloseout();
}
export function parseTrustedCloseoutKey(value: unknown): TrustedCloseoutKey {
  const input = closedObject(value, ["key_id", "public_key_spki"]);
  return { key_id: keyId(input["key_id"]), public_key_spki: canonicalSpki(input["public_key_spki"]) };
}
export function parseCloseoutSigningIdentity(value: unknown): CloseoutSigningIdentity {
  const input = closedObject(value, [
    "schema_version", "algorithm", "key_id", "public_key_spki", "public_key_fingerprint",
  ]);
  if (input["schema_version"] !== 1) return invalidCloseout();
  const publicKeySpki = canonicalSpki(input["public_key_spki"]);
  const fingerprint = closeoutDigest(input["public_key_fingerprint"]);
  const expectedFingerprint = `sha256:${createHash("sha256")
    .update(Buffer.from(publicKeySpki, "base64url")).digest("hex")}`;
  if (fingerprint !== expectedFingerprint) return invalidCloseout();
  return {
    schema_version: 1,
    algorithm: closeoutMember(input["algorithm"], ["Ed25519"] as const),
    key_id: keyId(input["key_id"]),
    public_key_spki: publicKeySpki,
    public_key_fingerprint: fingerprint,
  };
}
export function parseCloseoutEnvelope(value: unknown): CloseoutEnvelope {
  const input = closedObject(value, [
    "schema_version", "algorithm", "key_id", "public_key_spki", "public_key_fingerprint", "signature",
  ]);
  const identity = parseCloseoutSigningIdentity({
    schema_version: input["schema_version"],
    algorithm: input["algorithm"],
    key_id: input["key_id"],
    public_key_spki: input["public_key_spki"],
    public_key_fingerprint: input["public_key_fingerprint"],
  });
  const signature = closeoutText(input["signature"], 86);
  const bytes = Buffer.from(signature, "base64url");
  if (bytes.length !== 64 || bytes.toString("base64url") !== signature) return invalidCloseout();
  return { ...identity, signature };
}
export function verifyCloseoutSignature(
  domain: string,
  payload: unknown,
  envelope: CloseoutEnvelope,
  trusted: TrustedCloseoutKey,
): boolean {
  if (envelope.key_id !== trusted.key_id || envelope.public_key_spki !== trusted.public_key_spki) return false;
  try {
    return verify(
      null,
      closeoutSigningBytes(domain, payload),
      createPublicKey({ key: Buffer.from(envelope.public_key_spki, "base64url"), format: "der", type: "spki" }),
      Buffer.from(envelope.signature, "base64url"),
    );
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}
