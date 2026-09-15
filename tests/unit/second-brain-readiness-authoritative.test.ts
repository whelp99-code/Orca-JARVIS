import { describe, expect, it, vi } from "vitest";
import {
  SECOND_BRAIN_FROZEN_DIGEST,
  SECOND_BRAIN_REQUIRED_TOOLS,
  evaluateSecondBrainReadiness,
  type SecondBrainDataState,
  type SecondBrainProbeFailure,
  type SecondBrainReadinessObservation,
} from "../../src/second-brain-readiness.js";
import {
  runtimeSecondBrainReadinessProbe,
  type SecondBrainReadinessRunner,
} from "../../src/second-brain-readiness-runtime.js";
import { parseSecondBrainInstant } from "../../src/second-brain-readiness-time.js";
import { SECOND_BRAIN_PROTOCOL_VERSION } from "../../src/second-brain-transport.js";

const NOW = new Date("2026-08-28T12:00:00.000Z");

function syntheticPolicyObservation(
  overrides: Partial<SecondBrainReadinessObservation> = {},
): SecondBrainReadinessObservation {
  return {
    executable: "available",
    configuration: "valid",
    contract_digest: SECOND_BRAIN_FROZEN_DIGEST,
    protocol_version: SECOND_BRAIN_PROTOCOL_VERSION,
    tools: SECOND_BRAIN_REQUIRED_TOOLS,
    schemas_compatible: true,
    input_schemas_compatible: true,
    output_schemas_compatible: true,
    status: "ok",
    doctor: "ok",
    handshake: "ok",
    status_operational: true,
    doctor_operational: true,
    read_authorization: "authorized",
    write_authorization: "authorized",
    data_state: "ready",
    refresh: { kind: "success", completed_at: "2026-08-28T11:00:00.000Z" },
    ...overrides,
  };
}

function actualContractRunner(failure?: {
  readonly channel: "status" | "doctor" | "handshake";
  readonly kind: SecondBrainProbeFailure;
}): SecondBrainReadinessRunner {
  return {
    executable: async () => "available",
    configuration: async () => "valid",
    run: async command => command === failure?.channel
      ? { kind: failure.kind }
      : command === "status"
        ? { kind: "ok", stdout: "2026-08-28T11:00:00Z run fixture ok pages=1 conflicts=0 errors=0" }
        : { kind: "ok", stdout: JSON.stringify([
      { name: "python", status: "pass", detail: "app 1.0.0" },
      { name: "vault", status: "pass", detail: "mode=0o500" },
      { name: "scheduler-assets", status: "warn", detail: "deploy/systemd" },
    ]) },
    handshake: async () => failure?.channel === "handshake"
      ? { kind: failure.kind }
      : {
          kind: "ok",
          stdout: "",
          facts: {
            protocol_version: SECOND_BRAIN_PROTOCOL_VERSION,
            server_name: "second-brain",
            server_version: "0.1.0",
            tools: SECOND_BRAIN_REQUIRED_TOOLS,
            input_schemas_compatible: true,
            output_schemas_compatible: null,
          },
        },
  };
}

const PROCESS_FAILURES: readonly (readonly ["status" | "doctor" | "handshake", SecondBrainProbeFailure])[] = [
  ["status", "timeout"], ["status", "crash"], ["status", "nonzero"], ["status", "malformed"], ["status", "oversize"],
  ["doctor", "timeout"], ["doctor", "crash"], ["doctor", "nonzero"], ["doctor", "malformed"], ["doctor", "oversize"],
  ["handshake", "timeout"], ["handshake", "crash"], ["handshake", "nonzero"], ["handshake", "malformed"], ["handshake", "oversize"],
];

const DATA_STATES: readonly SecondBrainDataState[] = [
  "vault_absent", "vault_locked", "unavailable", "unknown", "no_data",
];

const AUTHORIZATION_CASES: readonly (readonly [
  SecondBrainReadinessObservation["read_authorization"],
  SecondBrainReadinessObservation["write_authorization"],
  string,
  boolean,
])[] = [
  ["authorized", "authorized", "read_write", true],
  ["authorized", "disabled", "read_only", false],
  ["authorized", "unauthorized", "read_only", false],
  ["unauthorized", "unauthorized", "unauthorized", false],
];

describe("authoritative Second Brain readiness boundaries", () => {
  it("keeps actual successful processes out of operational when the contract is unattested", async () => {
    // Given: every probe answers, but no read established the provider's own contract digest.
    const report = evaluateSecondBrainReadiness(
      await runtimeSecondBrainReadinessProbe(actualContractRunner()).inspect(),
      NOW,
    );
    // Then: succeeding processes are never green on their own.
    expect(report.stages.operational).toMatchObject({ state: "blocked", reason: "protocol_incompatible" });
    expect(report.stages.authorized.state).toBe("unauthorized");
    expect(report.readiness).toBe("unavailable");
  });

  it.each(PROCESS_FAILURES)("keeps actual %s %s distinct", async (channel, kind) => {
    const report = evaluateSecondBrainReadiness(
      await runtimeSecondBrainReadinessProbe(actualContractRunner({ channel, kind })).inspect(),
      NOW,
    );
    expect(report.stages.operational).toMatchObject({ state: "unavailable", reason: `${channel}_${kind}` });
  });

  it("rejects a non-finite platform timestamp parser result", () => {
    const parse = vi.spyOn(Date, "parse").mockReturnValue(Number.NaN);
    try {
      expect(parseSecondBrainInstant("2026-08-28T11:00:00Z")).toBeUndefined();
    } finally {
      parse.mockRestore();
    }
  });

  it("retains prior success when a newer attempt is capped", () => {
    const report = evaluateSecondBrainReadiness(syntheticPolicyObservation({
      refresh: { kind: "capped", attempted_at: "2026-08-28T11:30:00.000Z" },
      last_successful_refresh_at: "2026-08-28T10:00:00.000Z",
    }), NOW);
    expect(report.stages.last_successful_refresh).toMatchObject({
      state: "current_date",
      observed_at: "2026-08-28T10:00:00.000Z",
      latest_attempt: "capped",
    });
    expect(report.stages.freshness.state).toBe("fresh");
  });

  it.each([
    ["2026-08-28T00:30:00+02:00", "previous_date"],
    ["2026-08-27T23:30:00-02:00", "current_date"],
  ])("classifies %s by canonical UTC date", (completedAt, expected) => {
    const report = evaluateSecondBrainReadiness(syntheticPolicyObservation({
      refresh: { kind: "success", completed_at: completedAt },
    }), NOW);
    expect(report.stages.last_successful_refresh.state).toBe(expected);
  });

  it.each([
    "2026-02-31T11:00:00Z",
    "2026-08-28T11:00:00",
    "2026-08-28T13:00:00Z",
    "2026-08-28T11:00:00+99:00",
  ])("fails closed for malformed or future success %s", completedAt => {
    const report = evaluateSecondBrainReadiness(syntheticPolicyObservation({
      refresh: { kind: "success", completed_at: completedAt },
    }), NOW);
    expect(report.stages.last_successful_refresh).toMatchObject({
      state: "missing",
      reason: "refresh_malformed",
      observed_at: null,
      latest_attempt: "malformed",
    });
  });

  it.each(AUTHORIZATION_CASES)("evaluates synthetic authorization %s/%s", (read, write, state, canWrite) => {
    const report = evaluateSecondBrainReadiness(syntheticPolicyObservation({
      read_authorization: read,
      write_authorization: write,
    }), NOW);
    expect(report.stages.authorized).toMatchObject({ state, read: read === "authorized", write: canWrite });
  });

  it.each([
    ["input_schemas_compatible", false, "input_schema_mismatch"],
    ["output_schemas_compatible", false, "output_schema_mismatch"],
    ["protocol_version", "1900-01-01", "protocol_mismatch"],
    ["tools", ["sb_search"], "tool_mismatch"],
  ])("keeps synthetic compatibility drift for %s", (key, value, reason) => {
    const report = evaluateSecondBrainReadiness(syntheticPolicyObservation({ [key]: value }), NOW);
    expect(report.stages.protocol_compatible.reason).toBe(reason);
    expect(report.stages.operational).toMatchObject({ state: "blocked", reason: "protocol_incompatible" });
  });

  it.each(DATA_STATES)(
    "preserves synthetic data state %s independently",
    dataState => {
      const report = evaluateSecondBrainReadiness(syntheticPolicyObservation({
        data_state: dataState,
      }), NOW);
      expect(report.stages.data_state.state).toBe(dataState);
      expect(report.stages.operational.state).toBe("operational");
    },
  );

  it("fails closed on explicit synthetic channel contradiction", () => {
    const report = evaluateSecondBrainReadiness(syntheticPolicyObservation({ channels_consistent: false }), NOW);
    expect(report.stages.operational).toMatchObject({ state: "unavailable", reason: "probe_contradiction" });
  });

  it("is byte-identical when irrelevant Mac and PID state is disconnected", () => {
    const baseline = evaluateSecondBrainReadiness(syntheticPolicyObservation(), NOW);
    const irrelevant = { ...syntheticPolicyObservation(), mac_connected: false, pid_exists: true };
    expect(JSON.stringify(evaluateSecondBrainReadiness(irrelevant, NOW))).toBe(JSON.stringify(baseline));
  });
});
