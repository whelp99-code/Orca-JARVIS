export type CeremonyCredential = {
  readonly id: string;
  readonly rawId: string;
  readonly type: "public-key";
  readonly response: Readonly<Record<string, string>>;
  readonly authenticatorAttachment: string | null;
  readonly clientExtensionResults: Readonly<Record<string, never>>;
};

function bytesFrom(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    const code = binary.charCodeAt(index);
    out[index] = code;
  }
  return out;
}

function textFrom(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function gatewayOrigin(): boolean {
  return document.querySelector("meta[name='jarvis-phone-mode']") !== null;
}

export async function createPasskey(options: Record<string, unknown>): Promise<CeremonyCredential> {
  const user = options.user;
  const rp = options.rp;
  if (typeof user !== "object" || user === null || typeof rp !== "object" || rp === null) {
    throw new Error("Remote approval unavailable");
  }
  const userRecord = user as { id: string; name: string; displayName: string };
  const created = await navigator.credentials.create({
    publicKey: {
      challenge: bytesFrom(String(options.challenge)),
      rp: rp as PublicKeyCredentialRpEntity,
      user: { id: bytesFrom(userRecord.id), name: userRecord.name, displayName: userRecord.displayName },
      pubKeyCredParams: options.pubKeyCredParams as PublicKeyCredentialParameters[],
      timeout: Number(options.timeout),
      attestation: "none",
      authenticatorSelection: options.authenticatorSelection as AuthenticatorSelectionCriteria,
    },
  });
  if (!(created instanceof PublicKeyCredential)) throw new Error("Remote approval unavailable");
  const response = created.response as AuthenticatorAttestationResponse;
  const rawId = textFrom(created.rawId);
  return {
    id: rawId, rawId, type: "public-key", authenticatorAttachment: created.authenticatorAttachment,
    clientExtensionResults: {},
    response: { clientDataJSON: textFrom(response.clientDataJSON), attestationObject: textFrom(response.attestationObject) },
  };
}

export async function assertPasskey(options: Record<string, unknown>): Promise<CeremonyCredential> {
  const asserted = await navigator.credentials.get({
    publicKey: {
      challenge: bytesFrom(String(options.challenge)),
      rpId: String(options.rpId),
      timeout: Number(options.timeout),
      userVerification: "required",
      allowCredentials: [],
    },
  });
  if (!(asserted instanceof PublicKeyCredential)) throw new Error("Remote approval unavailable");
  const response = asserted.response as AuthenticatorAssertionResponse;
  if (response.userHandle === null) throw new Error("Remote approval unavailable");
  const rawId = textFrom(asserted.rawId);
  return {
    id: rawId, rawId, type: "public-key", authenticatorAttachment: asserted.authenticatorAttachment,
    clientExtensionResults: {},
    response: {
      clientDataJSON: textFrom(response.clientDataJSON),
      authenticatorData: textFrom(response.authenticatorData),
      signature: textFrom(response.signature),
      userHandle: textFrom(response.userHandle),
    },
  };
}
