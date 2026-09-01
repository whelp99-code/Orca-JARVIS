import { encodeCBOR } from "@levischuck/tiny-cbor";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { base64url } from "../../src/receipt.js";

export type P256Authenticator = Readonly<{
  privateKey: KeyObject;
  credentialId: Buffer;
  credentialIdB64: string;
  coseKey: Buffer;
  userHandle: Buffer;
}>;

export function createP256Authenticator(userHandle: Buffer): P256Authenticator {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  if (jwk.x === undefined || jwk.y === undefined) throw new Error("jwk");
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const coseKey = Buffer.from(encodeCBOR(new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, new Uint8Array(x)],
    [-3, new Uint8Array(y)],
  ])));
  const credentialId = createHash("sha256").update(Buffer.concat([x, y])).digest().subarray(0, 16);
  return {
    privateKey: pair.privateKey,
    credentialId,
    credentialIdB64: base64url(credentialId),
    coseKey,
    userHandle,
  };
}

export function authenticatorData(rpId: string, counter: number, flags = 0x05): Buffer {
  const rpIdHash = createHash("sha256").update(rpId).digest();
  const count = Buffer.alloc(4);
  count.writeUInt32BE(counter);
  return Buffer.concat([rpIdHash, Buffer.from([flags]), count]);
}

export function signAttestation(input: {
  readonly authenticator: P256Authenticator;
  readonly rpId: string;
  readonly origin: string;
  readonly challengeB64: string;
  readonly flags?: number;
}): Readonly<{
  id: string;
  rawId: string;
  type: "public-key";
  response: Readonly<{
    clientDataJSON: string;
    attestationObject: string;
  }>;
  authenticatorAttachment: null;
  clientExtensionResults: Record<string, never>;
}> {
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.create",
    challenge: input.challengeB64,
    origin: input.origin,
    crossOrigin: false,
  }), "utf8");
  const rpIdHash = createHash("sha256").update(input.rpId).digest();
  const flags = Buffer.from([input.flags ?? 0x45]);
  const counter = Buffer.alloc(4);
  const aaguid = Buffer.alloc(16);
  const credLen = Buffer.alloc(2);
  credLen.writeUInt16BE(input.authenticator.credentialId.byteLength);
  const authData = Buffer.concat([
    rpIdHash, flags, counter, aaguid, credLen, input.authenticator.credentialId, input.authenticator.coseKey,
  ]);
  const attestationObject = Buffer.from(encodeCBOR(new Map([
    ["fmt", "none"],
    ["attStmt", new Map()],
    ["authData", new Uint8Array(authData)],
  ])));
  return {
    id: input.authenticator.credentialIdB64,
    rawId: input.authenticator.credentialIdB64,
    type: "public-key",
    response: {
      clientDataJSON: base64url(clientDataJSON),
      attestationObject: base64url(attestationObject),
    },
    authenticatorAttachment: null,
    clientExtensionResults: {},
  };
}

export function signAssertion(input: {
  readonly authenticator: P256Authenticator;
  readonly rpId: string;
  readonly origin: string;
  readonly challengeB64: string;
  readonly counter: number;
  readonly flags?: number;
}): Readonly<{
  id: string;
  rawId: string;
  type: "public-key";
  response: Readonly<{
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string;
  }>;
  authenticatorAttachment: null;
  clientExtensionResults: Record<string, never>;
}> {
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge: input.challengeB64,
    origin: input.origin,
    crossOrigin: false,
  }), "utf8");
  const authData = authenticatorData(input.rpId, input.counter, input.flags ?? 0x05);
  const signed = Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]);
  const signature = sign("sha256", signed, input.authenticator.privateKey);
  return {
    id: input.authenticator.credentialIdB64,
    rawId: input.authenticator.credentialIdB64,
    type: "public-key",
    response: {
      clientDataJSON: base64url(clientDataJSON),
      authenticatorData: base64url(authData),
      signature: base64url(signature),
      userHandle: base64url(input.authenticator.userHandle),
    },
    authenticatorAttachment: null,
    clientExtensionResults: {},
  };
}
