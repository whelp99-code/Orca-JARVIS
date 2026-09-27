import { randomBytes } from "node:crypto";
import { sha256Prefixed } from "./remote-approval-crypto.js";
import { RemoteApprovalError } from "./remote-approval-errors.js";
import { parseAssertionCredential, parseVerifyBody } from "./remote-approval-parse.js";
import { parseSecondBrainStrictJsonBytes } from "./second-brain-strict-json.js";
import type { ChallengeRow, CredentialRow, RemoteApprovalStore } from "./remote-approval-store.js";

export type AuditFlags = { readonly up: number | null; readonly uv: number | null };

export function recordRemoteAudit(
  store: RemoteApprovalStore,
  challenge: ChallengeRow,
  now: Date,
  outcome: string,
  reason: string,
  credential: CredentialRow | null,
  counter: string,
  assertionDigest: string | null,
  flags: AuditFlags,
  distinct: string,
): void {
  const at = now.toISOString();
  const token = distinct.length === 0 ? at : `${at}:${distinct}`;
  store.insertAudit({
    event_id: `remote:${challenge.challenge_id}:${outcome}:${token}`,
    event_type: `remote.${outcome}`,
    subject_kind: "challenge",
    subject_id: sha256Prefixed(challenge.challenge_id),
    principal_id: challenge.remote_principal_id,
    correlation_id: challenge.request_id,
    event_digest: sha256Prefixed(`${challenge.challenge_id}:${outcome}:${token}`),
    created_at: at,
    outcome,
    reason_code: reason,
    credential_digest_prefix: credential ? credential.credential_id_digest.slice(7, 23) : null,
    request_digest: sha256Prefixed(challenge.request_id),
    command_digest: challenge.command_digest,
    binding_digest: challenge.binding_digest,
    assertion_digest: assertionDigest,
    counter_disposition: counter,
    up: flags.up,
    uv: flags.uv,
    origin_digest: sha256Prefixed(challenge.origin),
    rp_id_digest: sha256Prefixed(challenge.rp_id),
  });
}


export function writeRemoteAudit(
  store: RemoteApprovalStore,
  challenge: ChallengeRow,
  now: Date,
  outcome: string,
  reason: string,
  flags: AuditFlags = { up: null, uv: null },
): void {
  recordRemoteAudit(store, challenge, now, outcome, reason, null, "not_checked", null, flags, randomBytes(4).toString("hex"));
}

export function assertionAuditFlags(rawBody: Buffer): AuditFlags {
  try {
    const parsed = parseSecondBrainStrictJsonBytes(rawBody);
    if (parsed === undefined) return { up: null, uv: null };
    const assertion = parseAssertionCredential(parseVerifyBody(parsed));
    const byte = assertion.authenticatorData[32];
    if (byte === undefined) return { up: null, uv: null };
    return { up: (byte & 0x01) === 0 ? 0 : 1, uv: (byte & 0x04) === 0 ? 0 : 1 };
  } catch (error) {
    if (error instanceof RemoteApprovalError) return { up: null, uv: null };
    throw error;
  }
}
