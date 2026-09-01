export const SLO_CATALOG = {
  scheduler_lag: { threshold: 15_000, unit: "ms" },
  crash_recovery_rto: { threshold: 10_000, unit: "ms" },
  jarvis_backup_rpo: { threshold: 900_000, unit: "ms" },
  provider_backup_rpo: { threshold: 90_000_000, unit: "ms" },
  fixture_restore_rto: { threshold: 120_000, unit: "ms" },
  outbox_reconciliation_age: { threshold: 30_000, unit: "ms" },
  retention_schedule_lag: { threshold: 15_000, unit: "ms" },
} as const;

export type SloMetric = keyof typeof SLO_CATALOG;

export type SloSample = {
  readonly metric: SloMetric;
  readonly numerator: number | null;
  readonly denominator: number;
  readonly window_ms: number;
  readonly source_pid: number;
  readonly barrier_id: string;
};

export type SloRecord = {
  readonly metric: SloMetric;
  readonly numerator: number | null;
  readonly denominator: number;
  readonly unit: "ms";
  readonly window_ms: number;
  readonly threshold: number;
  readonly measured: number | null;
  readonly source_pid: number;
  readonly barrier_id: string;
  readonly verdict: "pass" | "fail" | "fail_missing_sample";
};

export function evaluateSlo(sample: SloSample): SloRecord {
  const catalog = SLO_CATALOG[sample.metric];
  if (sample.numerator === null || sample.denominator <= 0) {
    return {
      metric: sample.metric,
      numerator: sample.numerator,
      denominator: sample.denominator,
      unit: catalog.unit,
      window_ms: sample.window_ms,
      threshold: catalog.threshold,
      measured: null,
      source_pid: sample.source_pid,
      barrier_id: sample.barrier_id,
      verdict: "fail_missing_sample",
    };
  }
  const measured = sample.numerator / sample.denominator;
  return {
    metric: sample.metric,
    numerator: sample.numerator,
    denominator: sample.denominator,
    unit: catalog.unit,
    window_ms: sample.window_ms,
    threshold: catalog.threshold,
    measured,
    source_pid: sample.source_pid,
    barrier_id: sample.barrier_id,
    verdict: measured <= catalog.threshold ? "pass" : "fail",
  };
}
