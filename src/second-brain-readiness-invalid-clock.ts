import type { SecondBrainReadinessInvalidReportV1 } from "./second-brain-readiness.js";

export function invalidSecondBrainReadinessReport(): SecondBrainReadinessInvalidReportV1 {
  const unknown: { readonly state: "unknown"; readonly reason: "invalid_clock"; readonly checked_at: null } = {
    state: "unknown",
    reason: "invalid_clock",
    checked_at: null,
  };
  return {
    schema_version: 1,
    capability: "second_brain",
    checked_at: null,
    readiness: "unavailable",
    error: { code: "SECOND_BRAIN_CLOCK_INVALID" },
    stages: {
      installed: unknown,
      configured: unknown,
      protocol_compatible: unknown,
      operational: { state: "unavailable", reason: "invalid_clock", checked_at: null },
      authorized: {
        state: "unauthorized",
        reason: "invalid_clock",
        checked_at: null,
        read: false,
        write: false,
      },
      data_state: unknown,
      last_successful_refresh: {
        state: "missing",
        reason: "invalid_clock",
        checked_at: null,
        observed_at: null,
        latest_attempt: "malformed",
      },
      freshness: unknown,
    },
  };
}
