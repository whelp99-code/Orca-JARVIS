import type { IncomingMessage } from "node:http";

export const REMOTE_ALLOWED_ACTIONS = [
  "workflow.start",
  "workflow.advance",
  "workflow.cancel",
  "runbook.execute",
  "state.project",
  "evidence.negative.record",
] as const;

export type RemoteAllowedAction = (typeof REMOTE_ALLOWED_ACTIONS)[number];
export type RemoteDecision = "approve" | "reject";
export type Sha256Prefixed = `sha256:${string}`;
export type HmacSha256Prefixed = `hmac-sha256:${string}`;

export type RemoteIngressContextV1 = Readonly<{
  schema_version: 1;
  trust_mode: "gateway";
  gateway_owner_digest: Sha256Prefixed;
  gateway_session_digest: HmacSha256Prefixed;
  public_origin: string;
  request_method: "GET" | "POST";
  canonical_path: string;
  body_digest: Sha256Prefixed;
  envelope_nonce_digest: Sha256Prefixed;
  issued_at: string;
}>;

export type RemoteIngressResolver = (
  request: IncomingMessage,
  boundedBody: Buffer,
) => RemoteIngressContextV1 | null;

export type RemoteApprovalBindingV1 = Readonly<{
  schema_version: 1;
  challenge_id: string;
  request_id: string;
  decision: RemoteDecision;
  command_digest: Sha256Prefixed;
  action: string;
  action_level: number;
  target_digest: Sha256Prefixed;
  args_digest: Sha256Prefixed;
  request_nonce_digest: Sha256Prefixed;
  remote_principal_id: string;
  user_handle_digest: Sha256Prefixed;
  gateway_owner_digest: Sha256Prefixed;
  gateway_session_digest: HmacSha256Prefixed;
  origin: string;
  rp_id: string;
  issued_at: string;
  expires_at: string;
  challenge_nonce: string;
}>;

export type VerifiedRemoteBinding = Readonly<{
  request_id: string;
  challenge_id: string;
  decision: RemoteDecision;
  command_digest: Sha256Prefixed;
  assertion_id: string;
  assertion_digest: Sha256Prefixed;
  challenge_nonce_digest: Sha256Prefixed;
  issued_at: string;
  expires_at: string;
  command_expires_at: string;
}>;

export const FIXTURE_INGRESS_KEY = Buffer.from([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
]);

export const SESSION_DOMAIN = "orca-jarvis/remote-session/v1\0";
export const ENVELOPE_DOMAIN = "orca-jarvis/remote-ingress-envelope/v1\0";
export const RECEIPT_ID_DOMAIN = "orca-jarvis/remote-receipt-id/v1\0";
export const RECEIPT_NONCE_DOMAIN = "orca-jarvis/remote-receipt-nonce/v1\0";
export const BINDING_DOMAIN = "orca-jarvis/remote-approval-binding/v1\0";

export const FROZEN_VECTORS = {
  session: "a936f76eeb1f24775e2328483b03a1f7fc97a07d477cd497bcc6fccfbde76269",
  envelope: "8891c9b7c2807002bc247ddd767be91522ffdf0775ec5bab6dff962eebe55338",
  receipt_id: "2619274570542e0492ff25769d6f2d131996cc1edfee99d05ab152176867be19",
  receipt_nonce: "eda0ec687e16bc8cc076d1ac2bf069287bb182bebb790d2002cb294df99b1f6e",
} as const;

export const ENVELOPE_VECTOR = {
  body_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  issued_at: "2026-08-31T00:00:00.000Z",
  method: "POST",
  nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  path: "/api/v1/remote-approvals/request-fixture/options",
  schema_version: 1,
  session_digest: "hmac-sha256:2222222222222222222222222222222222222222222222222222222222222222",
} as const;

export const RECEIPT_ID_VECTOR = {
  assertion_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  challenge_id: "challenge-fixture",
  decision: "approve",
  request_id: "request-fixture",
  schema_version: 1,
} as const;

export const RECEIPT_NONCE_VECTOR = {
  assertion_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  challenge_nonce_digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
  request_id: "request-fixture",
  schema_version: 1,
} as const;
