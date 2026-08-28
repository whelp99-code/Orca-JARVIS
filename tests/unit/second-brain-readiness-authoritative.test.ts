import { describe, expect, it, vi } from "vitest";
import {
  SECOND_BRAIN_FROZEN_DIGEST,
  SECOND_BRAIN_REQUIRED_TOOLS,
  evaluateSecondBrainReadiness,
  type SecondBrainReadinessObservation,
} from "../../src/second-brain-readiness.js";
import {
  runtimeSecondBrainReadinessProbe,
  type SecondBrainReadinessRunner,
} from "../../src/second-brain-readiness-runtime.js";
import { parseSecondBrainInstant } from "../../src/second-brain-readiness-time.js";
import { SECOND_BRAIN_PROTOCOL_VERSION } from "../../src/second-brain-transport.js";

const NOW = new Date("2026-08-28T12:00:00.000Z");
const happy = (): SecondBrainReadinessObservation => ({
  executable: "available",
  configuration: "valid",
  contract_digest: SECOND_BRAIN_FROZEN_DIGEST,
  protocol_version: SECOND_BRAIN_PROTOCOL_VERSION,
  tools: SECOND_BRAIN_REQUIRED_TOOLS,
  schemas_compatible: true,
  status: "ok",
  doctor: "ok",
  handshake: "ok",
  read_authorization: "authorized",
  write_authorization: "authorized",
  data_state: "ready",
  refresh: { kind: "success", completed_at: "2026-08-28T11:00:00.000Z" },
});

function measuredRunner(input: {
  readonly status: string;
  readonly doctor: string;
  readonly handshake: string;
}): SecondBrainReadinessRunner {
  return {
    executable: async () => "available",
    configuration: async () => "valid",
    run: async command => ({ kind: "ok", stdout: command === "status" ? input.status : input.doctor }),
    handshake: async () => ({ kind: "ok", stdout: input.handshake }),
  };
}

const measured = (overrides: Readonly<Record<string, unknown>> = {}): string => JSON.stringify({
  schema_version: 1,
  operational: "ready",
  vault: "ready",
  data_state: "ready",
  authorization: { read: "authorized", write: "authorized" },
  contract_digest: SECOND_BRAIN_FROZEN_DIGEST,
  protocol_version: SECOND_BRAIN_PROTOCOL_VERSION,
  tools: SECOND_BRAIN_REQUIRED_TOOLS,
  input_schemas_compatible: true,
  output_schemas_compatible: true,
  latest_refresh_attempt: { kind: "success", at: "2026-08-28T11:00:00.000Z" },
  last_successful_refresh_at: "2026-08-28T11:00:00.000Z",
  ...overrides,
});

describe("authoritative measured Second Brain readiness", () => {
  it("does not substitute compatibility or authorization constants when peer facts are absent", async () => {
    // Given: status succeeds, doctor is silent, and startup completes without readiness facts.
    const runner = measuredRunner({
      status: "2026-08-28T11:00:00+00:00 run fixture ok pages=1 conflicts=0 errors=0",
      doctor: "",
      handshake: "",
    });
    // When: runtime readiness is inspected.
    const observed = await runtimeSecondBrainReadinessProbe(runner).inspect();
    // Then: every unobserved peer fact remains unknown and unauthorized.
    expect(observed).toMatchObject({
      contract_digest: null,
      protocol_version: null,
      tools: null,
      schemas_compatible: false,
      read_authorization: "unauthorized",
      write_authorization: "unauthorized",
    });
  });

  it("does not infer authorization from measured handshake metadata", async () => {
    // Given: only the handshake carries an authorization-shaped field.
    const runner = measuredRunner({
      status: "2026-08-28T11:00:00+00:00 run fixture ok pages=1 conflicts=0 errors=0",
      doctor: "",
      handshake: measured(),
    });
    // When: runtime readiness is inspected.
    const observed = await runtimeSecondBrainReadinessProbe(runner).inspect();
    // Then: status/doctor absence remains unauthorized.
    expect(observed).toMatchObject({
      read_authorization: "unauthorized",
      write_authorization: "unauthorized",
    });
  });

  it("fails closed when doctor reports a locked vault and drift despite a ready status and handshake", async () => {
    // Given: measured channels contradict each other.
    const runner = measuredRunner({
      status: measured(),
      doctor: measured({ vault: "locked", data_state: "vault_locked", contract_digest: "wrong" }),
      handshake: measured(),
    });
    // When: the contradiction is evaluated.
    const observed = await runtimeSecondBrainReadinessProbe(runner).inspect();
    const report = evaluateSecondBrainReadiness(observed, NOW);
    // Then: drift and lock cannot become compatible or operational.
    expect(report.stages.protocol_compatible.reason).toBe("digest_mismatch");
    expect(report.stages.operational).toMatchObject({ state: "unavailable", reason: "probe_contradiction" });
    expect(report.stages.data_state.state).toBe("vault_locked");
    expect(report.stages.authorized.state).toBe("unauthorized");
  });

  it("returns malformed without a raw throw for an invalid calendar timestamp", async () => {
    // Given: a date-shaped status line with an impossible month.
    const runner = measuredRunner({
      status: "2026-99-99T11:00:00+00:00 run fixture ok pages=1 conflicts=0 errors=0",
      doctor: measured(),
      handshake: measured(),
    });
    // When: the status is inspected.
    const action = runtimeSecondBrainReadinessProbe(runner).inspect();
    // Then: the boundary returns fixed malformed state rather than RangeError.
    await expect(action).resolves.toMatchObject({ status: "malformed", data_state: "unknown" });
  });

  it("rejects a non-finite platform parser result", () => {
    // Given: the platform parser returns a non-finite result for syntactically valid input.
    const parse = vi.spyOn(Date, "parse").mockReturnValue(Number.NaN);
    try {
      // When/Then: the strict boundary rejects it before ISO conversion.
      expect(parseSecondBrainInstant("2026-08-28T11:00:00Z")).toBeUndefined();
    } finally {
      parse.mockRestore();
    }
  });

  it("retains prior success when the latest attempt is capped", () => {
    // Given: a newer capped attempt and an independently retained prior success.
    const observation = {
      ...happy(),
      refresh: { kind: "capped" as const, attempted_at: "2026-08-28T11:30:00.000Z" },
      last_successful_refresh_at: "2026-08-28T10:00:00.000Z",
    };
    // When: readiness is evaluated.
    const report = evaluateSecondBrainReadiness(observation, NOW);
    // Then: latest attempt and successful freshness remain independent.
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
  ] as const)("classifies normalized UTC date for %s", (completed_at, expected) => {
    // Given: an offset instant crossing a UTC date boundary.
    const observation = { ...happy(), refresh: { kind: "success" as const, completed_at } };
    // When: readiness is evaluated.
    const report = evaluateSecondBrainReadiness(observation, NOW);
    // Then: classification uses normalized UTC, never the raw prefix.
    expect(report.stages.last_successful_refresh.state).toBe(expected);
  });

  it.each([
    ["2026-02-31T11:00:00Z", "malformed"],
    ["2026-08-28T11:00:00", "malformed"],
    ["2026-08-28T13:00:00Z", "malformed"],
    ["2026-08-28T11:00:00+99:00", "malformed"],
  ] as const)("fails closed for non-finite, timezone-free, offset, or future success %s", (completed_at, latest) => {
    // Given: a non-authoritative successful-refresh timestamp.
    const observation = { ...happy(), refresh: { kind: "success" as const, completed_at } };
    // When: readiness is evaluated.
    const report = evaluateSecondBrainReadiness(observation, NOW);
    // Then: no malformed value is promoted to successful history.
    expect(report.stages.last_successful_refresh).toMatchObject({
      state: "missing",
      reason: "refresh_malformed",
      observed_at: null,
      latest_attempt: latest,
    });
    expect(report.stages.freshness.state).toBe("unknown");
  });

  it.each([
    [{ read: "authorized", write: "authorized" }, "read_write", true],
    [{ read: "authorized", write: "disabled" }, "read_only", false],
    [{ read: "authorized", write: "unauthorized" }, "read_only", false],
    [{ read: "unauthorized", write: "unauthorized" }, "unauthorized", false],
  ] as const)("uses measured authorization %s", async (authorization, state, write) => {
    // Given: all channels report one exact authorization mode.
    const facts = measured({ authorization });
    const runner = measuredRunner({ status: facts, doctor: facts, handshake: facts });
    // When: runtime readiness is evaluated.
    const report = evaluateSecondBrainReadiness(await runtimeSecondBrainReadinessProbe(runner).inspect(), NOW);
    // Then: handshake grants no authority beyond the measured mode.
    expect(report.stages.authorized).toMatchObject({ state, read: authorization.read === "authorized", write });
  });

  it.each([
    ["input_schemas_compatible", false, "input_schema_mismatch"],
    ["output_schemas_compatible", false, "output_schema_mismatch"],
    ["protocol_version", "1900-01-01", "protocol_mismatch"],
    ["tools", ["sb_search"], "tool_mismatch"],
  ] as const)("reports measured compatibility drift for %s", async (key, value, reason) => {
    // Given: the handshake reports one measured drift.
    const runner = measuredRunner({ status: measured(), doctor: measured(), handshake: measured({ [key]: value }) });
    // When: runtime readiness is evaluated.
    const report = evaluateSecondBrainReadiness(await runtimeSecondBrainReadinessProbe(runner).inspect(), NOW);
    // Then: the exact drift remains machine-visible and blocks operation.
    expect(report.stages.protocol_compatible.reason).toBe(reason);
    expect(report.stages.operational).toMatchObject({ state: "unavailable", reason: "probe_contradiction" });
  });

  it.each([
    ["status", "timeout"], ["status", "crash"], ["status", "nonzero"], ["status", "malformed"], ["status", "oversize"],
    ["doctor", "timeout"], ["doctor", "crash"], ["doctor", "nonzero"], ["doctor", "malformed"], ["doctor", "oversize"],
    ["handshake", "timeout"], ["handshake", "crash"], ["handshake", "nonzero"], ["handshake", "malformed"], ["handshake", "oversize"],
  ] as const)("keeps %s %s distinct from measured health", async (source, failure) => {
    // Given: exactly one bounded channel fails with a typed process outcome.
    const ready = measured();
    const runner: SecondBrainReadinessRunner = {
      executable: async () => "available",
      configuration: async () => "valid",
      run: async command => command === source ? { kind: failure } : { kind: "ok", stdout: ready },
      handshake: async () => source === "handshake" ? { kind: failure } : { kind: "ok", stdout: ready },
    };
    // When: runtime readiness is evaluated.
    const report = evaluateSecondBrainReadiness(await runtimeSecondBrainReadinessProbe(runner).inspect(), NOW);
    // Then: the channel and process outcome are not collapsed.
    expect(report.stages.operational).toMatchObject({ state: "unavailable", reason: `${source}_${failure}` });
  });

  it.each([
    ["absent", "vault_absent"],
    ["locked", "vault_locked"],
  ] as const)("fails closed for measured vault %s", async (vault, dataState) => {
    // Given: status and doctor agree that the vault is not ready.
    const facts = measured({ vault, data_state: dataState, operational: "unavailable" });
    const runner = measuredRunner({ status: facts, doctor: facts, handshake: measured() });
    // When: runtime readiness is evaluated.
    const report = evaluateSecondBrainReadiness(await runtimeSecondBrainReadinessProbe(runner).inspect(), NOW);
    // Then: vault state remains distinct and operation is unavailable.
    expect(report.stages.data_state.state).toBe(dataState);
    expect(report.stages.operational.state).toBe("unavailable");
  });

  it("keeps measured no_data operational without fabricating evidence", async () => {
    // Given: all probes are healthy and current data is explicitly empty.
    const facts = measured({ data_state: "no_data" });
    const runner = measuredRunner({ status: facts, doctor: facts, handshake: facts });
    // When: runtime readiness is evaluated.
    const report = evaluateSecondBrainReadiness(await runtimeSecondBrainReadinessProbe(runner).inspect(), NOW);
    // Then: operation remains healthy while data stays no_data.
    expect(report.stages.operational.state).toBe("operational");
    expect(report.stages.data_state.state).toBe("no_data");
    expect(report.readiness).toBe("degraded");
  });

  it("orders attempts independently from retained success and replays deterministically", async () => {
    // Given: a newer failed attempt and older successful refresh appear across channels.
    const status = measured({
      latest_refresh_attempt: { kind: "failed", at: "2026-08-28T11:30:00.000Z" },
      last_successful_refresh_at: "2026-08-28T10:00:00.000Z",
    });
    const doctor = measured({
      latest_refresh_attempt: { kind: "success", at: "2026-08-28T10:00:00.000Z" },
      last_successful_refresh_at: "2026-08-28T10:00:00.000Z",
    });
    const runner = measuredRunner({ status, doctor, handshake: measured() });
    // When: identical measured facts are replayed.
    const first = evaluateSecondBrainReadiness(await runtimeSecondBrainReadinessProbe(runner).inspect(), NOW);
    const second = evaluateSecondBrainReadiness(await runtimeSecondBrainReadinessProbe(runner).inspect(), NOW);
    // Then: latest failure and prior successful freshness are both retained deterministically.
    expect(first.stages.last_successful_refresh).toMatchObject({
      state: "current_date",
      observed_at: "2026-08-28T10:00:00.000Z",
      latest_attempt: "failed",
    });
    expect(first.stages.freshness.state).toBe("fresh");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("is byte-identical when irrelevant Mac and PID state is disconnected", () => {
    // Given: the canonical observation has no client or process-presence field.
    const baseline = evaluateSecondBrainReadiness(happy(), NOW);
    const irrelevant = { ...happy(), mac_connected: false, pid_exists: true };
    // When: irrelevant state is supplied structurally.
    const replay = evaluateSecondBrainReadiness(irrelevant, NOW);
    // Then: neither field can alter readiness.
    expect(JSON.stringify(replay)).toBe(JSON.stringify(baseline));
  });
});
