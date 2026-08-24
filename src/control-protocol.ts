export const CONTROL_PROTOCOL_NAME = "jarvis-control";
export const CONTROL_PROTOCOL_VERSION = "1.0";
export const CONTROL_PROTOCOL_PREVIOUS = "1.0";
export const CONTROL_FRAME_MAX_BYTES = 1024 * 1024;

export const CONTROL_METHODS = [
  "capabilities.get",
  "command.request",
  "command.status",
  "approval.intent",
  "timeline.list",
  "timeline.subscribe",
  "worker.signal",
  "verification.run",
  "knowledge.query",
  "routine.manage",
  "evolution.propose",
] as const;
export type ControlMethod = (typeof CONTROL_METHODS)[number];

export const CONTROL_ERROR_CODES = [
  "invalid_request",
  "unsupported_version",
  "unauthenticated",
  "unauthorized",
  "stale_generation",
  "expired",
  "conflict",
  "not_found",
  "fenced",
  "uncertain",
  "internal",
] as const;
export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

export type CommandIntent = {
  readonly ingressIdempotencyKey: string;
  readonly requestedMethod: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly requestedAt: string;
  readonly expiresAt: string;
};

export type ControlError = {
  readonly code: ControlErrorCode;
  readonly message: string;
  readonly retryable: false;
};

type FrameBase = {
  readonly protocol: typeof CONTROL_PROTOCOL_NAME;
  readonly version: string;
  readonly id: string;
  readonly traceId: string;
  readonly generation: string;
  readonly sentAt: string;
};

export type ControlRequest = FrameBase & {
  readonly type: "request";
  readonly method: ControlMethod;
  readonly payload: unknown;
};

export type ControlResponseOk = FrameBase & {
  readonly type: "response";
  readonly replyTo: string;
  readonly ok: true;
  readonly payload: unknown;
};

export type ControlResponseErr = FrameBase & {
  readonly type: "response";
  readonly replyTo: string;
  readonly ok: false;
  readonly error: ControlError;
};

export type ControlEvent = FrameBase & {
  readonly type: "event";
  readonly sequence: number;
  readonly method: ControlMethod;
  readonly payload: unknown;
};

export type ControlFrame = ControlRequest | ControlResponseOk | ControlResponseErr | ControlEvent;

export type DecodeFailure = {
  readonly ok: false;
  readonly error: ControlError;
};

export type DecodeSuccess = {
  readonly ok: true;
  readonly frame: ControlFrame;
};

export type DecodeResult = DecodeSuccess | DecodeFailure;

export const FORBIDDEN_AUTHORITY_FIELDS = [
  "actionLevel",
  "reversibility",
  "authenticatedPrincipal",
  "trustTier",
  "principal",
  "receipt",
  "signingKey",
] as const;
