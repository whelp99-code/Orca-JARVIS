import { describe, expect, it } from "vitest";
import {
  SECOND_BRAIN_FROZEN_DIGEST,
  SECOND_BRAIN_REQUIRED_TOOLS,
  evaluateSecondBrainReadiness,
  type SecondBrainReadinessObservation,
} from "../../src/second-brain-readiness.js";
import { SECOND_BRAIN_PROTOCOL_VERSION } from "../../src/second-brain-transport.js";

const SYNTHETIC_POLICY_OBSERVATION: SecondBrainReadinessObservation = {
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
};

describe("Second Brain invalid injected clock", () => {
  it("returns a typed unavailable report without fabricating checked timestamps", () => {
    expect(() => evaluateSecondBrainReadiness(SYNTHETIC_POLICY_OBSERVATION, new Date(Number.NaN))).not.toThrow();
    expect(evaluateSecondBrainReadiness(SYNTHETIC_POLICY_OBSERVATION, new Date(Number.NaN))).toMatchObject({
      checked_at: null,
      readiness: "unavailable",
      error: { code: "SECOND_BRAIN_CLOCK_INVALID" },
      stages: {
        installed: { state: "unknown", reason: "invalid_clock", checked_at: null },
        operational: { state: "unavailable", reason: "invalid_clock", checked_at: null },
        authorized: { state: "unauthorized", reason: "invalid_clock", checked_at: null },
      },
    });
  });
});
