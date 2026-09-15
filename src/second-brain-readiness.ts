import { invalidSecondBrainReadinessReport } from "./second-brain-readiness-invalid-clock.js";
import type {
  SecondBrainReadinessReportV1,
  SecondBrainReadinessValidReportV1,
  SecondBrainStage,
} from "./second-brain-readiness-report.js";
import { parseSecondBrainInstant } from "./second-brain-readiness-time.js";
export type {
  SecondBrainReadinessInvalidReportV1,
  SecondBrainReadinessReportV1,
  SecondBrainReadinessValidReportV1,
} from "./second-brain-readiness-report.js";
import { SECOND_BRAIN_PROTOCOL_VERSION } from "./second-brain-transport.js";

export const SECOND_BRAIN_READINESS_VERSION = 1 as const;
export const SECOND_BRAIN_FROZEN_DIGEST = "1406f97695970a099af2569ab93777b67603a2a2261b9f6d03646e430d6098fe" as const;
export const SECOND_BRAIN_FRESHNESS_MS = 24 * 60 * 60 * 1_000;
export const SECOND_BRAIN_REQUIRED_TOOLS = [
  "sb_generation_status", "sb_open_conflicts", "sb_read_page", "sb_recent_changes", "sb_remember",
  "sb_request_status", "sb_resolve_memory_target", "sb_search", "sb_write_request",
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
  readonly configuration: "valid" | "missing" | "malformed" | "result_key_missing" | "unavailable";
  readonly contract_digest: string | null;
  readonly protocol_version: string | null;
  readonly tools: readonly string[] | null;
  readonly schemas_compatible: boolean;
  readonly input_schemas_compatible?: boolean | null;
  readonly output_schemas_compatible?: boolean | null;
  readonly status: SecondBrainProbeOutcome;
  readonly doctor: SecondBrainProbeOutcome;
  readonly handshake: SecondBrainProbeOutcome;
  readonly status_operational?: boolean | null;
  readonly doctor_operational?: boolean | null;
  readonly channels_consistent?: boolean;
  readonly read_authorization: "authorized" | "unauthorized";
  readonly write_authorization: "authorized" | "disabled" | "unauthorized";
  readonly authorization_consistent?: boolean;
  readonly data_state: SecondBrainDataState;
  readonly refresh: SecondBrainRefreshObservation;
  readonly last_successful_refresh_at?: string | null;
};

export interface SecondBrainReadinessProbe {
  inspect(): Promise<SecondBrainReadinessObservation>;
}

const checked = <State extends string, Reason extends string>(
  state: State,
  reason: Reason,
  checked_at: string,
): SecondBrainStage<State, Reason> => ({ state, reason, checked_at });
const toolsMatch = (tools: readonly string[] | null): boolean => tools !== null
  && [...tools].sort().join("\0") === [...SECOND_BRAIN_REQUIRED_TOOLS].sort().join("\0");

function protocolStage(observation: SecondBrainReadinessObservation, at: string): SecondBrainReadinessValidReportV1["stages"]["protocol_compatible"] {
  if (observation.contract_digest === null
    || observation.protocol_version === null
    || observation.tools === null) return checked("unknown", "protocol_unknown", at);
  if (observation.contract_digest !== SECOND_BRAIN_FROZEN_DIGEST) return checked("incompatible", "digest_mismatch", at);
  if (observation.protocol_version !== SECOND_BRAIN_PROTOCOL_VERSION) return checked("incompatible", "protocol_mismatch", at);
  if (!toolsMatch(observation.tools)) return checked("incompatible", "tool_mismatch", at);
  const inputSchemas = observation.input_schemas_compatible ?? observation.schemas_compatible;
  const outputSchemas = observation.output_schemas_compatible ?? observation.schemas_compatible;
  if (inputSchemas === null || outputSchemas === null) return checked("unknown", "protocol_unknown", at);
  if (!inputSchemas) return checked("incompatible", "input_schema_mismatch", at);
  return outputSchemas ? checked("compatible", "compatible", at) : checked("incompatible", "output_schema_mismatch", at);
}

function operationalStage(
  observation: SecondBrainReadinessObservation,
  compatible: boolean,
  at: string,
): SecondBrainReadinessValidReportV1["stages"]["operational"] {
  if (observation.status !== "ok") return checked("unavailable", `status_${observation.status}`, at);
  if (observation.doctor !== "ok") return checked("unavailable", `doctor_${observation.doctor}`, at);
  if (observation.handshake !== "ok") return checked("unavailable", `handshake_${observation.handshake}`, at);
  const statusOperational = observation.status_operational ?? null;
  const doctorOperational = observation.doctor_operational ?? null;
  if (statusOperational === null || doctorOperational === null) return checked("unavailable", "probe_facts_missing", at);
  if (observation.channels_consistent === false) return checked("unavailable", "probe_contradiction", at);
  if (!compatible) return checked("blocked", "protocol_incompatible", at);
  if (!statusOperational || !doctorOperational) return checked("unavailable", "probe_contradiction", at);
  return checked("operational", "probes_succeeded", at);
}

function authorizationStage(observation: SecondBrainReadinessObservation, at: string): SecondBrainReadinessValidReportV1["stages"]["authorized"] {
  if (observation.authorization_consistent === false) {
    return { ...checked("unauthorized", "authorization_mismatch", at), read: false, write: false };
  }
  if (observation.read_authorization === "unauthorized") return { ...checked("unauthorized", "read_unauthorized", at), read: false, write: false };
  if (observation.write_authorization === "authorized") return { ...checked("read_write", "authorized", at), read: true, write: true };
  if (observation.write_authorization === "disabled") return { ...checked("read_only", "write_disabled", at), read: true, write: false };
  return { ...checked("read_only", "write_unauthorized", at), read: true, write: false };
}

function refreshStages(
  observation: SecondBrainReadinessObservation,
  now: Date,
): Pick<SecondBrainReadinessValidReportV1["stages"], "last_successful_refresh" | "freshness"> {
  const nowMs = now.getTime();
  const at = Number.isFinite(nowMs) ? now.toISOString() : "invalid";
  const unknownFreshness = checked("unknown", "successful_refresh_missing", at);
  const attempt = parseLatestAttempt(observation.refresh, nowMs);
  const successValue = observation.last_successful_refresh_at
    ?? (observation.refresh.kind === "success" ? observation.refresh.completed_at : null);
  if (successValue === null) return {
    last_successful_refresh: {
      ...checked("missing", "refresh_missing", at),
      observed_at: null,
      latest_attempt: attempt,
    },
    freshness: unknownFreshness,
  };
  const success = parseSecondBrainInstant(successValue);
  if (success === undefined || !Number.isFinite(nowMs) || success.epoch_ms > nowMs) return {
    last_successful_refresh: {
      ...checked("missing", "refresh_malformed", at),
      observed_at: null,
      latest_attempt: attempt,
    },
    freshness: unknownFreshness,
  };
  const sameDate = success.canonical.slice(0, 10) === at.slice(0, 10);
  const fresh = nowMs - success.epoch_ms <= SECOND_BRAIN_FRESHNESS_MS;
  return {
    last_successful_refresh: {
      ...checked(
        sameDate ? "current_date" : "previous_date",
        sameDate ? "refresh_current_date" : "refresh_previous_date",
        at,
      ),
      observed_at: success.canonical,
      latest_attempt: attempt,
    },
    freshness: checked(fresh ? "fresh" : "stale", fresh ? "within_threshold" : "threshold_exceeded", at),
  };
}

function parseLatestAttempt(
  refresh: SecondBrainRefreshObservation,
  nowMs: number,
): SecondBrainReadinessValidReportV1["stages"]["last_successful_refresh"]["latest_attempt"] {
  if (refresh.kind === "missing") return "missing";
  const value = refresh.kind === "success" ? refresh.completed_at : refresh.attempted_at;
  const parsed = parseSecondBrainInstant(value);
  return parsed === undefined || !Number.isFinite(nowMs) || parsed.epoch_ms > nowMs ? "malformed" : refresh.kind;
}

export function evaluateSecondBrainReadiness(
  observation: SecondBrainReadinessObservation,
  now: Date,
): SecondBrainReadinessReportV1 {
  if (!Number.isFinite(now.getTime())) return invalidSecondBrainReadinessReport();
  const at = now.toISOString();
  const installed = observation.executable === "available" ? checked("available", "executable_available", at)
    : observation.executable === "missing" ? checked("missing", "executable_missing", at) : checked("unknown", "resolver_unavailable", at);
  // result_key_missing is a well-formed configuration with a hole in it: the provider signing key id
  // it names has no public key on file, which surfaces later as MEMORY_CANCELLATION_RESULT_INVALID.
  // It is reported under its own reason so the missing entry is diagnosable, and it is not valid.
  const configured = observation.configuration === "valid" ? checked("valid", "configuration_valid", at)
    : observation.configuration === "missing" ? checked("missing", "configuration_missing", at)
      : observation.configuration === "result_key_missing"
        ? checked("malformed", "configuration_provider_result_key_missing", at)
        : observation.configuration === "malformed" ? checked("malformed", "configuration_malformed", at) : checked("unknown", "configuration_unavailable", at);
  const protocol_compatible = protocolStage(observation, at);
  const operational = operationalStage(observation, protocol_compatible.state === "compatible", at);
  const authorized = authorizationStage(observation, at);
  const refresh = refreshStages(observation, now);
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
