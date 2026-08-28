import { SECOND_BRAIN_PROTOCOL_VERSION } from "./second-brain-transport.js";

export const SECOND_BRAIN_READINESS_VERSION = 1 as const;
export const SECOND_BRAIN_FROZEN_DIGEST = "2749af8b2a87b34e8a46191051d03126ff5bceebfb38c3f7a0b1acb0239acbaa" as const;
export const SECOND_BRAIN_FRESHNESS_MS = 24 * 60 * 60 * 1_000;
export const SECOND_BRAIN_REQUIRED_TOOLS = [
  "sb_open_conflicts", "sb_read_page", "sb_recent_changes", "sb_remember", "sb_search",
] as const;

export type SecondBrainProbeFailure = "timeout" | "crash" | "nonzero" | "malformed" | "oversize" | "locked" | "unavailable";
export type SecondBrainProbeOutcome = "ok" | SecondBrainProbeFailure;
export type SecondBrainDataState = "ready" | "no_data" | "vault_absent" | "vault_locked" | "unavailable" | "unknown";
export type SecondBrainRefreshObservation =
  | { readonly kind: "success"; readonly completed_at: string }
  | { readonly kind: "capped"; readonly attempted_at: string }
  | { readonly kind: "failed"; readonly attempted_at: string }
  | { readonly kind: "missing" };

export type SecondBrainReadinessObservation = {
  readonly executable: "available" | "missing" | "unavailable";
  readonly configuration: "valid" | "missing" | "malformed" | "unavailable";
  readonly contract_digest: string | null;
  readonly protocol_version: string | null;
  readonly tools: readonly string[] | null;
  readonly schemas_compatible: boolean;
  readonly status: SecondBrainProbeOutcome;
  readonly doctor: SecondBrainProbeOutcome;
  readonly handshake: SecondBrainProbeOutcome;
  readonly read_authorization: "authorized" | "unauthorized";
  readonly write_authorization: "authorized" | "disabled" | "unauthorized";
  readonly data_state: SecondBrainDataState;
  readonly refresh: SecondBrainRefreshObservation;
};

export interface SecondBrainReadinessProbe {
  inspect(): Promise<SecondBrainReadinessObservation>;
}

type Stage<State extends string, Reason extends string> = {
  readonly state: State;
  readonly reason: Reason;
  readonly checked_at: string;
};
type ConfiguredStage = Stage<
  "valid" | "missing" | "malformed" | "unknown",
  "configuration_valid" | "configuration_missing" | "configuration_malformed" | "configuration_unavailable"
>;
type ProtocolStage = Stage<
  "compatible" | "incompatible" | "unknown",
  "compatible" | "digest_mismatch" | "protocol_mismatch" | "tool_mismatch" | "schema_mismatch" | "protocol_unknown"
>;
type OperationalReason = "probes_succeeded" | "protocol_incompatible"
  | `status_${SecondBrainProbeFailure}` | `doctor_${SecondBrainProbeFailure}` | `handshake_${SecondBrainProbeFailure}`;
type AuthorizationStage = Stage<
  "read_write" | "read_only" | "unauthorized",
  "authorized" | "write_disabled" | "write_unauthorized" | "read_unauthorized"
> & { readonly read: boolean; readonly write: boolean };
type RefreshStage = Stage<
  "current_date" | "previous_date" | "missing" | "capped" | "failed",
  "refresh_current_date" | "refresh_previous_date" | "refresh_missing" | "refresh_capped" | "refresh_failed"
> & { readonly observed_at: string | null };

export type SecondBrainReadinessReportV1 = {
  readonly schema_version: 1;
  readonly capability: "second_brain";
  readonly checked_at: string;
  readonly readiness: "ready" | "degraded" | "unavailable";
  readonly stages: {
    readonly installed: Stage<
      "available" | "missing" | "unknown",
      "executable_available" | "executable_missing" | "resolver_unavailable"
    >;
    readonly configured: ConfiguredStage;
    readonly protocol_compatible: ProtocolStage;
    readonly operational: Stage<"operational" | "unavailable" | "blocked", OperationalReason>;
    readonly authorized: AuthorizationStage;
    readonly data_state: Stage<SecondBrainDataState, `data_${SecondBrainDataState}`>;
    readonly last_successful_refresh: RefreshStage;
    readonly freshness: Stage<
      "fresh" | "stale" | "unknown",
      "within_threshold" | "threshold_exceeded" | "successful_refresh_missing"
    >;
  };
};

const checked = <State extends string, Reason extends string>(
  state: State,
  reason: Reason,
  checked_at: string,
): Stage<State, Reason> => ({ state, reason, checked_at });
const toolsMatch = (tools: readonly string[] | null): boolean => tools !== null
  && [...tools].sort().join("\0") === [...SECOND_BRAIN_REQUIRED_TOOLS].sort().join("\0");

function protocolStage(observation: SecondBrainReadinessObservation, at: string): SecondBrainReadinessReportV1["stages"]["protocol_compatible"] {
  if (observation.contract_digest === null
    || observation.protocol_version === null
    || observation.tools === null) return checked("unknown", "protocol_unknown", at);
  if (observation.contract_digest !== SECOND_BRAIN_FROZEN_DIGEST) return checked("incompatible", "digest_mismatch", at);
  if (observation.protocol_version !== SECOND_BRAIN_PROTOCOL_VERSION) return checked("incompatible", "protocol_mismatch", at);
  if (!toolsMatch(observation.tools)) return checked("incompatible", "tool_mismatch", at);
  return observation.schemas_compatible ? checked("compatible", "compatible", at) : checked("incompatible", "schema_mismatch", at);
}

function operationalStage(
  observation: SecondBrainReadinessObservation,
  compatible: boolean,
  at: string,
): SecondBrainReadinessReportV1["stages"]["operational"] {
  if (!compatible) return checked("blocked", "protocol_incompatible", at);
  if (observation.status !== "ok") return checked("unavailable", `status_${observation.status}`, at);
  if (observation.doctor !== "ok") return checked("unavailable", `doctor_${observation.doctor}`, at);
  if (observation.handshake !== "ok") return checked("unavailable", `handshake_${observation.handshake}`, at);
  return checked("operational", "probes_succeeded", at);
}

function authorizationStage(observation: SecondBrainReadinessObservation, at: string): SecondBrainReadinessReportV1["stages"]["authorized"] {
  if (observation.read_authorization === "unauthorized") return { ...checked("unauthorized", "read_unauthorized", at), read: false, write: false };
  if (observation.write_authorization === "authorized") return { ...checked("read_write", "authorized", at), read: true, write: true };
  if (observation.write_authorization === "disabled") return { ...checked("read_only", "write_disabled", at), read: true, write: false };
  return { ...checked("read_only", "write_unauthorized", at), read: true, write: false };
}

function refreshStages(
  refresh: SecondBrainRefreshObservation,
  now: Date,
): Pick<SecondBrainReadinessReportV1["stages"], "last_successful_refresh" | "freshness"> {
  const at = now.toISOString();
  const unknownFreshness = checked("unknown", "successful_refresh_missing", at);
  if (refresh.kind === "missing") return {
    last_successful_refresh: { ...checked("missing", "refresh_missing", at), observed_at: null },
    freshness: unknownFreshness,
  };
  if (refresh.kind === "capped") return {
    last_successful_refresh: { ...checked("capped", "refresh_capped", at), observed_at: null },
    freshness: unknownFreshness,
  };
  if (refresh.kind === "failed") return {
    last_successful_refresh: { ...checked("failed", "refresh_failed", at), observed_at: null },
    freshness: unknownFreshness,
  };
  const completed = Date.parse(refresh.completed_at);
  if (!Number.isFinite(completed) || completed > now.getTime()) return {
    last_successful_refresh: { ...checked("missing", "refresh_missing", at), observed_at: null },
    freshness: unknownFreshness,
  };
  const sameDate = refresh.completed_at.slice(0, 10) === at.slice(0, 10);
  const last = {
    ...checked(
      sameDate ? "current_date" : "previous_date",
      sameDate ? "refresh_current_date" : "refresh_previous_date",
      at,
    ),
    observed_at: new Date(completed).toISOString(),
  };
  const fresh = now.getTime() - completed <= SECOND_BRAIN_FRESHNESS_MS;
  return { last_successful_refresh: last, freshness: checked(fresh ? "fresh" : "stale", fresh ? "within_threshold" : "threshold_exceeded", at) };
}

export function evaluateSecondBrainReadiness(observation: SecondBrainReadinessObservation, now: Date): SecondBrainReadinessReportV1 {
  const at = now.toISOString();
  const installed = observation.executable === "available" ? checked("available", "executable_available", at)
    : observation.executable === "missing" ? checked("missing", "executable_missing", at) : checked("unknown", "resolver_unavailable", at);
  const configured = observation.configuration === "valid" ? checked("valid", "configuration_valid", at)
    : observation.configuration === "missing" ? checked("missing", "configuration_missing", at)
      : observation.configuration === "malformed" ? checked("malformed", "configuration_malformed", at) : checked("unknown", "configuration_unavailable", at);
  const protocol_compatible = protocolStage(observation, at);
  const operational = operationalStage(observation, protocol_compatible.state === "compatible", at);
  const authorized = authorizationStage(observation, at);
  const refresh = refreshStages(observation.refresh, now);
  const data_state = checked(observation.data_state, `data_${observation.data_state}`, at);
  const core = installed.state === "available"
    && configured.state === "valid"
    && protocol_compatible.state === "compatible"
    && operational.state === "operational"
    && authorized.read;
  const fullyReady = authorized.write && data_state.state === "ready" && refresh.freshness.state === "fresh";
  const readiness = core && fullyReady ? "ready" : core ? "degraded" : "unavailable";
  return {
    schema_version: SECOND_BRAIN_READINESS_VERSION,
    capability: "second_brain",
    checked_at: at,
    readiness,
    stages: { installed, configured, protocol_compatible, operational, authorized, data_state, ...refresh },
  };
}

export function passiveSecondBrainReadinessProbe(): SecondBrainReadinessProbe {
  return {
    inspect: async () => ({
      executable: "unavailable",
      configuration: "unavailable",
      contract_digest: null,
      protocol_version: null,
      tools: null,
      schemas_compatible: false,
      status: "unavailable",
      doctor: "unavailable",
      handshake: "unavailable",
      read_authorization: "unauthorized",
      write_authorization: "unauthorized",
      data_state: "unknown",
      refresh: { kind: "missing" },
    }),
  };
}

export async function buildSecondBrainReadiness(probe: SecondBrainReadinessProbe, now = new Date()): Promise<SecondBrainReadinessReportV1> {
  return evaluateSecondBrainReadiness(await probe.inspect(), now);
}
