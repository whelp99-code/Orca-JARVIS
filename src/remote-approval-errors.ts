export const REMOTE_ERROR_CODES = {
  REMOTE_REQUEST_INVALID: "REMOTE_REQUEST_INVALID",
  REMOTE_SESSION_REQUIRED: "REMOTE_SESSION_REQUIRED",
  REMOTE_CEREMONY_REJECTED: "REMOTE_CEREMONY_REJECTED",
  REMOTE_APPROVAL_UNAVAILABLE: "REMOTE_APPROVAL_UNAVAILABLE",
  REMOTE_APPROVAL_NOT_APPLICABLE: "REMOTE_APPROVAL_NOT_APPLICABLE",
  REMOTE_RATE_LIMITED: "REMOTE_RATE_LIMITED",
  REMOTE_AUTHORITY_UNAVAILABLE: "REMOTE_AUTHORITY_UNAVAILABLE",
} as const;

export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[keyof typeof REMOTE_ERROR_CODES];

export const REMOTE_ERROR_STATUS: Readonly<Record<RemoteErrorCode, number>> = {
  REMOTE_REQUEST_INVALID: 400,
  REMOTE_SESSION_REQUIRED: 401,
  REMOTE_CEREMONY_REJECTED: 403,
  REMOTE_APPROVAL_UNAVAILABLE: 404,
  REMOTE_APPROVAL_NOT_APPLICABLE: 409,
  REMOTE_RATE_LIMITED: 429,
  REMOTE_AUTHORITY_UNAVAILABLE: 503,
};

export const REMOTE_PUBLIC_MESSAGE = "Remote approval unavailable";

export class RemoteApprovalError extends Error {
  readonly name = "RemoteApprovalError";
  readonly status: number;
  constructor(readonly code: RemoteErrorCode, readonly reason: string = code) {
    super(REMOTE_PUBLIC_MESSAGE);
    this.status = REMOTE_ERROR_STATUS[code];
  }
}

export type RemoteErrorBody = Readonly<{
  schema_version: 1;
  error: Readonly<{
    code: RemoteErrorCode;
    message: typeof REMOTE_PUBLIC_MESSAGE;
    request_id: string;
  }>;
}>;

export function remoteErrorBody(code: RemoteErrorCode, requestId: string): RemoteErrorBody {
  return {
    schema_version: 1,
    error: { code, message: REMOTE_PUBLIC_MESSAGE, request_id: requestId },
  };
}
