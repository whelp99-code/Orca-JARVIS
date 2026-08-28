import { describe, expect, it } from "vitest";
import {
  SECOND_BRAIN_FRESHNESS_MS,
  SECOND_BRAIN_FROZEN_DIGEST,
  SECOND_BRAIN_REQUIRED_TOOLS,
  evaluateSecondBrainReadiness,
  type SecondBrainReadinessObservation,
} from "../../src/second-brain-readiness.js";
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

describe("Second Brain staged readiness", () => {
  it("reports every independent happy stage with fixed machine values", () => {
    // Given: exact frozen compatibility and successful bounded probes.
    const input = happy();
    // When: readiness is evaluated at an injected time.
    const report = evaluateSecondBrainReadiness(input, NOW);
    // Then: the canonical report is ready without provider prose.
    expect(report).toMatchObject({ schema_version: 1, capability: "second_brain", readiness: "ready" });
    expect(Object.keys(report.stages)).toEqual([
      "installed", "configured", "protocol_compatible", "operational", "authorized",
      "data_state", "last_successful_refresh", "freshness",
    ]);
    expect(report.stages.protocol_compatible).toMatchObject({ state: "compatible", reason: "compatible" });
    expect(report.stages.operational).toMatchObject({ state: "operational", reason: "probes_succeeded" });
    expect(report.stages.authorized).toMatchObject({ state: "read_write", read: true, write: true });
    expect(report.stages.freshness.state).toBe("fresh");
  });

  it.each([
    ["contract_digest", "wrong", "digest_mismatch"],
    ["protocol_version", "1900-01-01", "protocol_mismatch"],
    ["tools", ["sb_search"], "tool_mismatch"],
    ["schemas_compatible", false, "schema_mismatch"],
  ] as const)("fails closed for %s drift before operational readiness", (key, value, reason) => {
    // Given: one frozen compatibility field has drifted.
    const input = { ...happy(), [key]: value };
    // When: readiness is evaluated.
    const report = evaluateSecondBrainReadiness(input, NOW);
    // Then: compatibility names the drift and probes cannot produce green health.
    expect(report.stages.protocol_compatible).toMatchObject({ state: "incompatible", reason });
    expect(report.stages.operational).toEqual({ state: "blocked", reason: "protocol_incompatible", checked_at: NOW.toISOString() });
  });

  it.each(["timeout", "crash", "nonzero", "malformed", "oversize", "locked", "unavailable"] as const)(
    "keeps status %s distinct and does not infer health from history",
    failure => {
      // Given: historical success but the current status probe fails.
      const input = { ...happy(), status: failure };
      // When: readiness is evaluated.
      const report = evaluateSecondBrainReadiness(input, NOW);
      // Then: current operational health is unavailable with a stable reason.
      expect(report.stages.operational).toMatchObject({ state: "unavailable", reason: `status_${failure}` });
      expect(report.stages.last_successful_refresh.state).toBe("current_date");
      expect(report.readiness).toBe("unavailable");
    },
  );

  it.each([
    ["doctor", "malformed", "doctor_malformed"],
    ["handshake", "oversize", "handshake_oversize"],
    ["handshake", "timeout", "handshake_timeout"],
    ["doctor", "crash", "doctor_crash"],
    ["doctor", "nonzero", "doctor_nonzero"],
    ["handshake", "locked", "handshake_locked"],
  ] as const)("keeps %s %s as a distinct operational failure", (probe, failure, reason) => {
    // Given: one current bounded probe fails.
    const input = { ...happy(), [probe]: failure };
    // When: readiness is evaluated.
    const report = evaluateSecondBrainReadiness(input, NOW);
    // Then: the exact probe and failure remain visible.
    expect(report.stages.operational).toMatchObject({ state: "unavailable", reason });
  });

  it.each([
    ["missing", "configuration_missing"],
    ["malformed", "configuration_malformed"],
    ["unavailable", "configuration_unavailable"],
  ] as const)("keeps configuration %s distinct", (configuration, reason) => {
    // Given: a non-valid safe configuration result.
    const input = { ...happy(), configuration };
    // When: readiness is evaluated.
    const report = evaluateSecondBrainReadiness(input, NOW);
    // Then: configuration is not collapsed into installation or operation.
    expect(report.stages.installed.state).toBe("available");
    expect(report.stages.configured.reason).toBe(reason);
  });

  it.each(["vault_absent", "vault_locked", "unavailable", "unknown"] as const)("preserves data state %s", data_state => {
    // Given: one provider data-state outcome.
    const input = { ...happy(), data_state };
    // When: readiness is evaluated.
    const report = evaluateSecondBrainReadiness(input, NOW);
    // Then: data state does not rewrite operational health.
    expect(report.stages.data_state).toMatchObject({ state: data_state, reason: `data_${data_state}` });
    expect(report.stages.operational.state).toBe("operational");
  });

  it.each([
    [{ kind: "missing" }, "missing"],
    [{ kind: "failed", attempted_at: "2026-08-28T11:00:00.000Z" }, "failed"],
    [{ kind: "capped", attempted_at: "2026-08-28T11:00:00.000Z" }, "capped"],
    [{ kind: "success", completed_at: "2026-08-27T11:00:00.000Z" }, "previous_date"],
  ] as const)("never promotes refresh outcome %s", (refresh, expected) => {
    // Given: an exact provider refresh outcome.
    const input = { ...happy(), refresh };
    // When: readiness is evaluated.
    const report = evaluateSecondBrainReadiness(input, NOW);
    // Then: only success carries a successful observed time.
    expect(report.stages.last_successful_refresh.state).toBe(expected);
    expect(report.stages.last_successful_refresh.observed_at === null).toBe(refresh.kind !== "success");
  });

  it("distinguishes write unauthorized from fully unauthorized", () => {
    // Given: read authorization exists without write authorization.
    const readOnly = evaluateSecondBrainReadiness({ ...happy(), write_authorization: "unauthorized" }, NOW);
    // When: read authorization is also removed.
    const unauthorized = evaluateSecondBrainReadiness({ ...happy(), read_authorization: "unauthorized" }, NOW);
    // Then: read-only reporting and full denial remain distinct.
    expect(readOnly.stages.authorized).toMatchObject({ state: "read_only", reason: "write_unauthorized", read: true, write: false });
    expect(unauthorized.stages.authorized).toMatchObject({ state: "unauthorized", reason: "read_unauthorized", read: false, write: false });
  });

  it("preserves no-data, vault, authorization, and refresh outcomes independently", () => {
    // Given: read-only service, no data, and a capped current attempt.
    const input: SecondBrainReadinessObservation = {
      ...happy(), data_state: "no_data", write_authorization: "disabled",
      refresh: { kind: "capped", attempted_at: "2026-08-28T11:30:00.000Z" },
    };
    // When: readiness is evaluated.
    const report = evaluateSecondBrainReadiness(input, NOW);
    // Then: none of the distinct outcomes is promoted or erased.
    expect(report.stages.operational.state).toBe("operational");
    expect(report.stages.authorized).toMatchObject({ state: "read_only", reason: "write_disabled", read: true, write: false });
    expect(report.stages.data_state).toMatchObject({ state: "no_data", reason: "data_no_data" });
    expect(report.stages.last_successful_refresh).toMatchObject({ state: "capped", reason: "refresh_capped", observed_at: null });
    expect(report.stages.freshness.state).toBe("unknown");
    expect(report.readiness).toBe("degraded");
  });

  it.each([
    [SECOND_BRAIN_FRESHNESS_MS - 1, "fresh"],
    [SECOND_BRAIN_FRESHNESS_MS, "fresh"],
    [SECOND_BRAIN_FRESHNESS_MS + 1, "stale"],
  ] as const)("uses an inclusive deterministic freshness boundary at age %s", (age, expected) => {
    // Given: an exact successful-refresh age.
    const completed_at = new Date(NOW.getTime() - age).toISOString();
    // When: the same input is replayed.
    const first = evaluateSecondBrainReadiness({ ...happy(), refresh: { kind: "success", completed_at } }, NOW);
    const second = evaluateSecondBrainReadiness({ ...happy(), refresh: { kind: "success", completed_at } }, NOW);
    // Then: equality is byte-deterministic and the threshold is inclusive.
    expect(first.stages.freshness.state).toBe(expected);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("never carries injected paths, credentials, diagnostics, or Mac state into the report", () => {
    // Given: the typed boundary contains only fixed machine vocabulary.
    const input = happy();
    // When: readiness is evaluated.
    const text = JSON.stringify(evaluateSecondBrainReadiness(input, NOW));
    // Then: private boundary values have no public representation.
    expect(text).not.toMatch(/\/home\/|token|password|authorization["=:]|stdout|stderr|mac/i);
  });
});
