import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { base64url } from "./receipt.js";
import { RemoteApprovalError, REMOTE_ERROR_CODES } from "./remote-approval-errors.js";
import type { ParsedAssertion, ParsedAttestation } from "./remote-approval-parse.js";

export type AuthenticationVerifyResult = Readonly<{
  verified: true;
  newCounter: number;
  userVerified: boolean;
  backupEligible: boolean;
  backupState: boolean;
  origin: string;
  rpId: string;
}>;

export type RegistrationVerifyResult = Readonly<{
  verified: true;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  backupEligible: boolean;
  backupState: boolean;
  algorithm: -7 | -8;
}>;

function jsonFromBytes(bytes: Buffer): string {
  return bytes.toString("utf8");
}

export async function verifyAssertionCrypto(input: {
  readonly assertion: ParsedAssertion;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string;
  readonly expectedRpId: string;
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
}): Promise<AuthenticationVerifyResult> {
  const response = {
    id: input.assertion.id,
    rawId: input.assertion.id,
    type: "public-key" as const,
    response: {
      clientDataJSON: base64url(input.assertion.clientDataJSON),
      authenticatorData: base64url(input.assertion.authenticatorData),
      signature: base64url(input.assertion.signature),
      userHandle: base64url(input.assertion.userHandle),
    },
    clientExtensionResults: {},
  };
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      credential: {
        id: input.credentialId,
        publicKey: Uint8Array.from(input.publicKey),
        counter: input.counter,
      },
      requireUserVerification: true,
    });
  } catch {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "crypto");
  }
  if (!result.verified || !result.authenticationInfo.userVerified) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "unverified");
  }
  const client = JSON.parse(jsonFromBytes(input.assertion.clientDataJSON)) as Record<string, unknown>;
  if (client.type !== "webauthn.get") {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "type");
  }
  if (client.crossOrigin === true || "topOrigin" in client) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "origin");
  }
  const flags = input.assertion.authenticatorData[32];
  if (flags === undefined || (flags & 0x01) === 0 || (flags & 0x04) === 0) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "uv");
  }
  return {
    verified: true,
    newCounter: result.authenticationInfo.newCounter,
    userVerified: true,
    backupEligible: result.authenticationInfo.credentialDeviceType === "multiDevice",
    backupState: result.authenticationInfo.credentialBackedUp,
    origin: result.authenticationInfo.origin,
    rpId: result.authenticationInfo.rpID,
  };
}

export async function verifyAttestationCrypto(input: {
  readonly attestation: ParsedAttestation;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string;
  readonly expectedRpId: string;
}): Promise<RegistrationVerifyResult> {
  const response = {
    id: input.attestation.id,
    rawId: input.attestation.id,
    type: "public-key" as const,
    response: {
      clientDataJSON: base64url(input.attestation.clientDataJSON),
      attestationObject: base64url(input.attestation.attestationObject),
    },
    clientExtensionResults: {},
  };
  let result;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -8],
    });
  } catch {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "crypto");
  }
  if (!result.verified || result.registrationInfo === undefined) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "unverified");
  }
  const client = JSON.parse(jsonFromBytes(input.attestation.clientDataJSON)) as Record<string, unknown>;
  if (client.type !== "webauthn.create") {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "type");
  }
  if (client.crossOrigin === true || "topOrigin" in client) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "origin");
  }
  const info = result.registrationInfo;
  return {
    verified: true,
    credentialId: info.credential.id,
    publicKey: info.credential.publicKey,
    counter: info.credential.counter,
    backupEligible: info.credentialDeviceType === "multiDevice",
    backupState: info.credentialBackedUp,
    algorithm: -7,
  };
}
