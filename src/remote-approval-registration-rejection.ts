import { RemoteEnrollmentStore, type RegistrationCeremonyRow } from "./remote-approval-enrollment-store.js";
import { RemoteApprovalError, REMOTE_ERROR_CODES, type RemoteErrorCode } from "./remote-approval-errors.js";
import { registrationCeremonyBound } from "./remote-approval-ingress.js";
import type { RemoteApprovalService } from "./remote-approval.js";
import { writeRegistrationRejectionAudit } from "./remote-approval-audit.js";
import type { RemoteIngressContextV1 } from "./remote-approval-types.js";

type RegistrationVerifyClass =
  | { readonly kind: "reject"; readonly code: RemoteErrorCode; readonly reason: string; readonly outcome: "rejected" | "expired" }
  | { readonly kind: "proceed"; readonly row: RegistrationCeremonyRow };

const REGISTRATION_STATES = ["issued", "verifying", "consumed", "expired", "rejected"] as const;
type RegistrationState = (typeof REGISTRATION_STATES)[number];

/** Commits expiry, then audits a closed rejection. Returns the issued ceremony when verify may continue. */
export function admitRegistrationVerify(input: {
  readonly service: RemoteApprovalService;
  readonly ceremonyId: string;
  readonly ingress: RemoteIngressContextV1;
  readonly now: Date;
}): RegistrationCeremonyRow {
  const at = input.now.toISOString();
  commitRegistrationExpiry({ service: input.service, ceremonyId: input.ceremonyId, at, now: input.now });
  const row = new RemoteEnrollmentStore(input.service.options.db).ceremony(input.ceremonyId);
  const classified = classifyRegistrationVerify({
    row, ingress: input.ingress, now: input.now,
    bound: row !== undefined && registrationCeremonyBound(input.service.options.db, row, input.now),
  });
  if (classified.kind === "reject") {
    auditRegistrationRejection({
      service: input.service, ceremonyId: input.ceremonyId, row, now: input.now,
      outcome: classified.outcome, reason: classified.reason,
    });
    throw new RemoteApprovalError(classified.code, classified.reason);
  }
  return classified.row;
}

export function auditRegistrationRejection(input: RegistrationRejectionRecord): void {
  input.service.options.db.db.transaction(() => {
    recordRegistrationRejectionAudit(input);
  }).immediate();
}

export function recordRegistrationRejectionAudit(input: RegistrationRejectionRecord): void {
  writeRegistrationRejectionAudit(input.service.store, {
    ceremonyId: input.ceremonyId,
    correlationId: input.row?.begin_request_id ?? input.ceremonyId,
    principalId: input.row?.principal_id ?? null,
    origin: input.row?.origin ?? input.service.options.origin,
    rpId: input.row?.rp_id ?? input.service.options.rpId,
    now: input.now,
    outcome: input.outcome,
    reason: input.reason,
  });
}

type RegistrationRejectionRecord = {
  readonly service: RemoteApprovalService;
  readonly ceremonyId: string;
  readonly row: RegistrationCeremonyRow | undefined;
  readonly now: Date;
  readonly outcome: "rejected" | "expired";
  readonly reason: string;
};

function registrationState(value: string): RegistrationState {
  for (const state of REGISTRATION_STATES) {
    if (state === value) return state;
  }
  throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "state");
}

function classifyRegistrationVerify(input: {
  readonly row: RegistrationCeremonyRow | undefined;
  readonly ingress: RemoteIngressContextV1;
  readonly now: Date;
  readonly bound: boolean;
}): RegistrationVerifyClass {
  const row = input.row;
  if (row === undefined) return { kind: "reject", code: REMOTE_ERROR_CODES.REMOTE_SESSION_REQUIRED, reason: "missing", outcome: "rejected" };
  const state = registrationState(row.state);
  switch (state) {
    case "consumed":
    case "rejected":
      return { kind: "reject", code: REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, reason: state, outcome: "rejected" };
    case "expired":
      return { kind: "reject", code: REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, reason: "expired", outcome: "expired" };
    case "issued":
    case "verifying":
      if (Date.parse(row.expires_at) <= input.now.getTime()) {
        return { kind: "reject", code: REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, reason: "expired", outcome: "expired" };
      }
      if (state === "verifying") {
        return { kind: "reject", code: REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, reason: state, outcome: "rejected" };
      }
      if (row.gateway_session_digest !== input.ingress.gateway_session_digest) {
        return { kind: "reject", code: REMOTE_ERROR_CODES.REMOTE_SESSION_REQUIRED, reason: "session", outcome: "rejected" };
      }
      if (!input.bound) return { kind: "reject", code: REMOTE_ERROR_CODES.REMOTE_SESSION_REQUIRED, reason: "binding", outcome: "rejected" };
      return { kind: "proceed", row };
    default:
      return assertNever(state);
  }
}

function commitRegistrationExpiry(input: {
  readonly service: RemoteApprovalService;
  readonly ceremonyId: string;
  readonly at: string;
  readonly now: Date;
}): void {
  const store = new RemoteEnrollmentStore(input.service.options.db);
  input.service.options.db.db.transaction(() => {
    store.expireRegistrations(input.at);
    const current = store.ceremony(input.ceremonyId);
    if (current !== undefined && (current.state === "issued" || current.state === "verifying") && Date.parse(current.expires_at) <= input.now.getTime()) {
      input.service.options.db.db.prepare(
        "UPDATE webauthn_registration_ceremonies_v2 SET state='expired', terminal_reason='expired' WHERE ceremony_id=? AND state IN ('issued','verifying')",
      ).run(input.ceremonyId);
    }
  }).immediate();
}

function assertNever(value: never): never {
  throw new Error(`unexpected registration state ${JSON.stringify(value)}`);
}
