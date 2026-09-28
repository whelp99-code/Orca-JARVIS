import type { CDPSession, Page } from "@playwright/test";

export type VirtualAuthenticator = {
  readonly cdp: CDPSession;
  readonly authenticatorId: string;
};

export type CredentialJson = {
  readonly id: string;
  readonly rawId: string;
  readonly type: "public-key";
  readonly response: Readonly<Record<string, string>>;
  readonly authenticatorAttachment: string | null;
  readonly clientExtensionResults: Readonly<Record<string, never>>;
};

type AuthenticatorTransport = "internal" | "usb";

function authenticatorOptions(transport: AuthenticatorTransport) {
  return {
    protocol: "ctap2" as const,
    transport,
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  };
}

export async function attachVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  return addVirtualAuthenticator(cdp, "internal");
}

export async function addVirtualAuthenticator(
  cdp: CDPSession, transport: AuthenticatorTransport = "internal",
): Promise<VirtualAuthenticator> {
  const added = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: authenticatorOptions(transport),
  });
  return { cdp, authenticatorId: added.authenticatorId };
}

export async function setAutomaticPresence(
  authenticator: VirtualAuthenticator, enabled: boolean,
): Promise<void> {
  await authenticator.cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId: authenticator.authenticatorId,
    enabled,
  });
}

export async function setBogusSignature(
  authenticator: VirtualAuthenticator, bogus: boolean,
): Promise<void> {
  await authenticator.cdp.send("WebAuthn.setResponseOverrideBits", {
    authenticatorId: authenticator.authenticatorId,
    isBogusSignature: bogus,
  });
}

export async function setUserVerified(authenticator: VirtualAuthenticator, verified: boolean): Promise<void> {
  await authenticator.cdp.send("WebAuthn.setUserVerified", {
    authenticatorId: authenticator.authenticatorId,
    isUserVerified: verified,
  });
}

export async function setBadUv(authenticator: VirtualAuthenticator, bad: boolean): Promise<void> {
  await authenticator.cdp.send("WebAuthn.setResponseOverrideBits", {
    authenticatorId: authenticator.authenticatorId,
    isBadUV: bad,
  });
}

export async function createResidentCredential(
  page: Page, options: Record<string, unknown>,
): Promise<CredentialJson> {
  return page.evaluate(async raw => {
    const b64ToU8 = (value: string): Uint8Array<ArrayBuffer> => {
      const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      const binary = atob(padded);
      const out = new Uint8Array(new ArrayBuffer(binary.length));
      for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
      return out;
    };
    const u8ToB64 = (bytes: ArrayBuffer): string => {
      const view = new Uint8Array(bytes);
      let binary = "";
      for (const byte of view) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    };
    const user = raw.user;
    const rp = raw.rp;
    if (typeof user !== "object" || user === null || typeof rp !== "object" || rp === null) {
      throw new Error("options");
    }
    const userRecord = user as { id: string; name: string; displayName: string };
    const rpRecord = rp as PublicKeyCredentialRpEntity;
    const exclude = Array.isArray(raw.excludeCredentials) ? raw.excludeCredentials : [];
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: b64ToU8(String(raw.challenge)),
        rp: rpRecord,
        user: { id: b64ToU8(userRecord.id), name: userRecord.name, displayName: userRecord.displayName },
        pubKeyCredParams: raw.pubKeyCredParams as PublicKeyCredentialParameters[],
        timeout: Number(raw.timeout),
        attestation: "none",
        excludeCredentials: exclude.map(item => {
          const row = item as { id: string };
          return { type: "public-key" as const, id: b64ToU8(row.id) };
        }),
        authenticatorSelection: raw.authenticatorSelection as AuthenticatorSelectionCriteria,
      },
    });
    if (!(credential instanceof PublicKeyCredential)) throw new Error("create");
    const response = credential.response as AuthenticatorAttestationResponse;
    const rawId = u8ToB64(credential.rawId);
    return {
      id: rawId, rawId, type: "public-key" as const,
      response: {
        clientDataJSON: u8ToB64(response.clientDataJSON),
        attestationObject: u8ToB64(response.attestationObject),
      },
      authenticatorAttachment: credential.authenticatorAttachment ?? null,
      clientExtensionResults: {},
    };
  }, options);
}

export async function getResidentAssertion(
  page: Page, options: Record<string, unknown>, allowCredentialId?: string,
): Promise<CredentialJson> {
  return page.evaluate(async input => {
    const b64ToU8 = (value: string): Uint8Array<ArrayBuffer> => {
      const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      const binary = atob(padded);
      const out = new Uint8Array(new ArrayBuffer(binary.length));
      for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
      return out;
    };
    const u8ToB64 = (bytes: ArrayBuffer): string => {
      const view = new Uint8Array(bytes);
      let binary = "";
      for (const byte of view) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    };
    const allow = input.allowCredentialId === undefined
      ? []
      : [{ type: "public-key" as const, id: b64ToU8(input.allowCredentialId) }];
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: b64ToU8(String(input.options.challenge)),
        rpId: String(input.options.rpId),
        timeout: Number(input.options.timeout),
        userVerification: "required",
        allowCredentials: allow,
      },
    });
    if (!(credential instanceof PublicKeyCredential)) throw new Error("get");
    const response = credential.response as AuthenticatorAssertionResponse;
    if (response.userHandle === null) throw new Error("userHandle");
    const rawId = u8ToB64(credential.rawId);
    return {
      id: rawId, rawId, type: "public-key" as const,
      response: {
        clientDataJSON: u8ToB64(response.clientDataJSON),
        authenticatorData: u8ToB64(response.authenticatorData),
        signature: u8ToB64(response.signature),
        userHandle: u8ToB64(response.userHandle),
      },
      authenticatorAttachment: credential.authenticatorAttachment ?? null,
      clientExtensionResults: {},
    };
  }, { options, allowCredentialId });
}
