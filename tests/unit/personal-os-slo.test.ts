import { describe, expect, it } from "vitest";
import { evaluateSlo, SLO_CATALOG } from "../../src/personal-os-slo.js";

describe("personal-OS SLO catalog", () => {
  it("records numerator, denominator, window, and threshold for backup RPO", () => {
    // Given
    const sample = {
      metric: "jarvis_backup_rpo" as const,
      numerator: 120_000,
      denominator: 1,
      window_ms: 900_000,
      source_pid: 4242,
      barrier_id: "backup_verified",
    };

    // When
    const record = evaluateSlo(sample);

    // Then
    expect(record.threshold).toBe(SLO_CATALOG.jarvis_backup_rpo.threshold);
    expect(record.threshold).toBe(900_000);
    expect(record.verdict).toBe("pass");
    expect(record.unit).toBe("ms");
    expect(record.measured).toBe(120_000);
  });

  it("fails closed when a sample is missing or a threshold is exceeded", () => {
    // Given / When
    const missing = evaluateSlo({
      metric: "provider_backup_rpo",
      numerator: null,
      denominator: 1,
      window_ms: 90_000_000,
      source_pid: 1,
      barrier_id: "provider_backup",
    });
    const exceeded = evaluateSlo({
      metric: "scheduler_lag",
      numerator: 20_000,
      denominator: 1,
      window_ms: 15_000,
      source_pid: 1,
      barrier_id: "morning",
    });

    // Then
    expect(missing.verdict).toBe("fail_missing_sample");
    expect(exceeded.verdict).toBe("fail");
    expect(SLO_CATALOG.provider_backup_rpo.threshold).toBe(90_000_000);
    expect(SLO_CATALOG.retention_schedule_lag.threshold).toBe(15_000);
    expect(SLO_CATALOG.crash_recovery_rto.threshold).toBe(10_000);
  });
});
