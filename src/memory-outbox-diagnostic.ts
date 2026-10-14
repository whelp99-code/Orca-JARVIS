import { JarvisError } from "./jarvis-error.js";

const codes = {
  cycle: "MEMORY_OUTBOX_CYCLE_FAILED",
  recover_dispatch: "MEMORY_OUTBOX_RECOVER_DISPATCH_FAILED",
  claim_dispatch: "MEMORY_OUTBOX_CLAIM_DISPATCH_FAILED",
  dispatch: "MEMORY_OUTBOX_DISPATCH_FAILED",
  provider_write: "MEMORY_OUTBOX_PROVIDER_WRITE_FAILED",
  record_write_result: "MEMORY_OUTBOX_RECORD_WRITE_RESULT_FAILED",
  claim_reconciliation: "MEMORY_OUTBOX_CLAIM_RECONCILIATION_FAILED",
  provider_observation: "MEMORY_OUTBOX_PROVIDER_OBSERVATION_FAILED",
  record_observation: "MEMORY_OUTBOX_RECORD_OBSERVATION_FAILED",
  settlement: "MEMORY_OUTBOX_SETTLEMENT_FAILED",
  control_reconciliation: "MEMORY_OUTBOX_CONTROL_RECONCILE_FAILED",
  review_cleanup: "MEMORY_REVIEW_CLEANUP_FAILED",
} as const;
const approvedCauseCodes = new Set([
  "MEMORY_OUTBOX_CYCLE_FAILED",
  "MEMORY_OUTBOX_TIME_INVALID",
  "MEMORY_OUTBOX_REPLAY_CONFLICT",
  "MEMORY_OUTBOX_INTEGRITY_FAILURE",
  "MEMORY_OUTBOX_AUTHORITY_INVALID",
  "MEMORY_OUTBOX_STALE_FENCE",
  "MEMORY_OUTBOX_EVIDENCE_CONFLICT",
  "MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID",
  "MEMORY_OUTBOX_CONTROL_RECONCILE_FAILED",
  "MEMORY_REVIEW_CLEANUP_FAILED",
  "MEMORY_READ_FENCE_CONFIG_INVALID",
  "MEMORY_READ_FENCE_KEY_UNAVAILABLE",
  "MEMORY_READ_FENCE_AUTHORITY_UNAVAILABLE",
]);
export type MemoryOutboxPhase = keyof typeof codes;
export type MemoryOutboxFailure = {
  readonly phase: MemoryOutboxPhase;
  readonly error_code: string;
  readonly cause_code: string;
};

// Keep the original exception identity without retaining or copying private details.
const phases = new WeakMap<object, MemoryOutboxPhase>();
const snapshots = new WeakMap<object, MemoryOutboxFailure>();
const recoveries = new WeakMap<object, readonly MemoryOutboxFailure[]>();
const GENERIC_CAUSE = "MEMORY_OUTBOX_UNCLASSIFIED_ERROR";
export function tagMemoryOutboxFailure(phase: MemoryOutboxPhase, error: unknown): unknown {
  const tagged = (typeof error === "object" && error !== null) || typeof error === "function"
    ? error : new Error(GENERIC_CAUSE);
  phases.set(tagged, phase);
  snapshots.delete(tagged);
  return tagged;
}
export function memoryOutboxFailure(error: unknown): MemoryOutboxFailure {
  const object = (typeof error === "object" && error !== null) || typeof error === "function" ? error : undefined;
  const snapshot = object === undefined ? undefined : snapshots.get(object);
  if (snapshot !== undefined) return snapshot;
  const phase = object === undefined ? "cycle" : phases.get(object) ?? "cycle";
  let code = GENERIC_CAUSE;
  try { code = error instanceof JarvisError ? error.code : GENERIC_CAUSE; }
  catch { code = GENERIC_CAUSE; }
  const cause = approvedCauseCodes.has(code) ? code : GENERIC_CAUSE;
  const failure = { phase, error_code: codes[phase], cause_code: cause };
  if (object !== undefined) snapshots.set(object, failure);
  return failure;
}
export function memoryOutboxLog(failure: MemoryOutboxFailure | null) {
  return { component: "memory.outbox", error_code: failure?.error_code ?? null,
    phase: failure?.phase ?? null, cause_code: failure?.cause_code ?? null };
}
export function markMemoryOutboxRecovery<T extends object>(value: T, retired: readonly MemoryOutboxFailure[]): T {
  if (retired.length > 0) recoveries.set(value, retired);
  return value;
}
export function memoryOutboxRecoveries(value: object): readonly MemoryOutboxFailure[] { return recoveries.get(value) ?? []; }
export function memoryOutboxRecovered(value: object, failure: MemoryOutboxFailure | undefined): boolean {
  return failure !== undefined && memoryOutboxRecoveries(value).includes(failure);
}
