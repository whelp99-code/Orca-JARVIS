import type {
  SecondBrainDataState,
  SecondBrainProbeFailure,
} from "./second-brain-readiness.js";

export type SecondBrainStage<State extends string, Reason extends string> = {
  readonly state: State;
  readonly reason: Reason;
  readonly checked_at: string;
};
type ConfiguredStage = SecondBrainStage<
  "valid" | "missing" | "malformed" | "unknown",
  "configuration_valid" | "configuration_missing" | "configuration_malformed" | "configuration_unavailable"
>;
type ProtocolStage = SecondBrainStage<
  "compatible" | "incompatible" | "unknown",
  "compatible" | "digest_mismatch" | "protocol_mismatch" | "tool_mismatch" | "input_schema_mismatch"
    | "output_schema_mismatch" | "protocol_unknown"
>;
type OperationalReason = "probes_succeeded" | "protocol_incompatible" | "probe_contradiction" | "probe_facts_missing"
  | `status_${SecondBrainProbeFailure}` | `doctor_${SecondBrainProbeFailure}` | `handshake_${SecondBrainProbeFailure}`;
type AuthorizationStage = SecondBrainStage<
  "read_write" | "read_only" | "unauthorized",
  "authorized" | "write_disabled" | "write_unauthorized" | "read_unauthorized" | "authorization_mismatch"
> & { readonly read: boolean; readonly write: boolean };
type RefreshStage = SecondBrainStage<
  "current_date" | "previous_date" | "missing",
  "refresh_current_date" | "refresh_previous_date" | "refresh_missing" | "refresh_malformed"
> & {
  readonly observed_at: string | null;
  readonly latest_attempt: "success" | "capped" | "failed" | "missing" | "malformed";
};

export type SecondBrainReadinessValidReportV1 = {
  readonly schema_version: 1;
  readonly capability: "second_brain";
  readonly checked_at: string;
  readonly readiness: "ready" | "degraded" | "unavailable";
  readonly stages: {
    readonly installed: SecondBrainStage<
      "available" | "missing" | "unknown",
      "executable_available" | "executable_missing" | "resolver_unavailable"
    >;
    readonly configured: ConfiguredStage;
    readonly protocol_compatible: ProtocolStage;
    readonly operational: SecondBrainStage<"operational" | "unavailable" | "blocked", OperationalReason>;
    readonly authorized: AuthorizationStage;
    readonly data_state: SecondBrainStage<SecondBrainDataState, `data_${SecondBrainDataState}`>;
    readonly last_successful_refresh: RefreshStage;
    readonly freshness: SecondBrainStage<
      "fresh" | "stale" | "unknown",
      "within_threshold" | "threshold_exceeded" | "successful_refresh_missing"
    >;
  };
};

export type SecondBrainReadinessInvalidReportV1 = {
  readonly schema_version: 1;
  readonly capability: "second_brain";
  readonly checked_at: null;
  readonly readiness: "unavailable";
  readonly error: { readonly code: "SECOND_BRAIN_CLOCK_INVALID" };
  readonly stages: {
    readonly installed: InvalidStage<"unknown">;
    readonly configured: InvalidStage<"unknown">;
    readonly protocol_compatible: InvalidStage<"unknown">;
    readonly operational: InvalidStage<"unavailable">;
    readonly authorized: InvalidStage<"unauthorized"> & { readonly read: false; readonly write: false };
    readonly data_state: InvalidStage<"unknown">;
    readonly last_successful_refresh: InvalidStage<"missing"> & {
      readonly observed_at: null;
      readonly latest_attempt: "malformed";
    };
    readonly freshness: InvalidStage<"unknown">;
  };
};

type InvalidStage<State extends string> = {
  readonly state: State;
  readonly reason: "invalid_clock";
  readonly checked_at: null;
};

export type SecondBrainReadinessReportV1 = SecondBrainReadinessValidReportV1 | SecondBrainReadinessInvalidReportV1;
