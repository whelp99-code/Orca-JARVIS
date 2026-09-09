import {
  SecondBrainTransportError,
  SECOND_BRAIN_LIMITS,
  type SecondBrainCallOptions,
  type SecondBrainContractProfile,
  type SecondBrainMethod,
  type SecondBrainOutcome,
  type SecondBrainTimerHandle,
} from "./second-brain-transport-contract.js";

export function requireSecondBrainProfile(profile: unknown): SecondBrainContractProfile {
  if (profile !== "scoped-request-status-v1" && profile !== "scoped-request-write-v1" && profile !== "scoped-record-read-v5"
    && profile !== "scoped-record-read-v4" && profile !== "scoped-record-read-v3" && profile !== "scoped-record-read-v2" && profile !== "scoped-record-read-v1"
    && profile !== "task32-schema4" && profile !== "remember-schema5"
    && profile !== "cancellation-schema6" && profile !== "cancellation-submit-schema7") {
    throw new SecondBrainTransportError("SECOND_BRAIN_CONTRACT_PROFILE_INVALID", "fatal", { generation: 0 });
  }
  return profile;
}

export type SecondBrainPending = {
  readonly id: string;
  readonly method?: SecondBrainMethod;
  readonly write: boolean;
  dispatched: boolean;
  readonly started: number;
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: SecondBrainTransportError) => void;
  readonly timer: SecondBrainTimerHandle;
  readonly signal?: AbortSignal;
  abort?: () => void;
};
export type SecondBrainQueueItem = {
  readonly method: SecondBrainMethod;
  readonly arguments_: Readonly<Record<string, unknown>>;
  readonly options: SecondBrainCallOptions;
  readonly resolve: (value: SecondBrainOutcome) => void;
  readonly reject: (error: SecondBrainTransportError) => void;
  cancelled: boolean;
  settled: boolean;
  abort?: () => void;
};
export type SecondBrainGenerationState = "idle" | "starting" | "ready" | "failed";
export type SecondBrainErrorCorrelation = {
  readonly generation: number;
  readonly request_id?: string;
  readonly method?: SecondBrainMethod;
};

export function isSecondBrainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function secondBrainRecord(value: unknown): Record<string, unknown> {
  if (!isSecondBrainRecord(value)) {
    throw new SecondBrainTransportError("SECOND_BRAIN_MALFORMED_FRAME", "fatal", { generation: 0 });
  }
  return Object.fromEntries(Object.entries(value));
}

export function isScopedTransportProfile(profile: SecondBrainContractProfile): boolean {
  return profile === "scoped-request-status-v1" || profile === "scoped-request-write-v1"
    || profile === "scoped-record-read-v1" || profile === "scoped-record-read-v2"
    || profile === "scoped-record-read-v3" || profile === "scoped-record-read-v4" || profile === "scoped-record-read-v5";
}
export function secondBrainArgumentLimit(profile: SecondBrainContractProfile, method: SecondBrainMethod): number {
  return profile === "scoped-request-write-v1" ? 32780
    : method === "sb_submit_cancellation" ? 16_395 : SECOND_BRAIN_LIMITS.argument_bytes;
}
