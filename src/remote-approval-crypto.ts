import { createHash, createHmac } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { base64url } from "./receipt.js";
import {
  BINDING_DOMAIN,
  ENVELOPE_DOMAIN,
  RECEIPT_ID_DOMAIN,
  RECEIPT_NONCE_DOMAIN,
  SESSION_DOMAIN,
  type HmacSha256Prefixed,
  type RemoteApprovalBindingV1,
  type Sha256Prefixed,
} from "./remote-approval-types.js";

export function sha256Prefixed(value: string | Buffer): Sha256Prefixed {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hmacHex(key: Buffer, domain: string, payload: string): string {
  return createHmac("sha256", key).update(domain).update(payload).digest("hex");
}

export function gatewaySessionDigest(key: Buffer, serverSessionDigest: string): HmacSha256Prefixed {
  return `hmac-sha256:${hmacHex(key, SESSION_DOMAIN, serverSessionDigest)}`;
}

export function ingressMac(key: Buffer, envelope: unknown): string {
  return hmacHex(key, ENVELOPE_DOMAIN, canonicalize(envelope));
}

export function remoteReceiptId(binding: unknown): string {
  const digest = createHash("sha256").update(RECEIPT_ID_DOMAIN).update(canonicalize(binding)).digest("hex");
  return `remote-receipt:${digest}`;
}

export function remoteReceiptNonce(binding: unknown): string {
  const digest = createHash("sha256").update(RECEIPT_NONCE_DOMAIN).update(canonicalize(binding)).digest("hex");
  return `remote-approval:${digest}`;
}

export function bindingChallenge(binding: RemoteApprovalBindingV1): string {
  const digest = createHash("sha256").update(BINDING_DOMAIN).update(canonicalize(binding)).digest();
  return base64url(digest);
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
