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
export type MemoryOutboxPhase = keyof typeof codes;
export type MemoryOutboxFailure = {
  readonly phase: MemoryOutboxPhase;
  readonly error_code: string;
  readonly cause_code: string;
};

// Keep the original exception identity without retaining or copying private details.
const phases = new WeakMap<object, MemoryOutboxPhase>();
const GENERIC_CAUSE = "MEMORY_OUTBOX_UNCLASSIFIED_ERROR";
export function tagMemoryOutboxFailure(phase: MemoryOutboxPhase, error: unknown): unknown {
  const tagged = (typeof error === "object" && error !== null) || typeof error === "function"
    ? error : new Error(GENERIC_CAUSE);
  phases.set(tagged, phase);
  return tagged;
}
export function memoryOutboxFailure(error: unknown): MemoryOutboxFailure {
  const phase = (typeof error === "object" && error !== null) || typeof error === "function"
    ? phases.get(error) ?? "cycle" : "cycle";
  const cause = error instanceof JarvisError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code : GENERIC_CAUSE;
  return { phase, error_code: codes[phase], cause_code: cause };
}
export function memoryOutboxLog(failure: MemoryOutboxFailure | null) {
  return { component: "memory.outbox", error_code: failure?.error_code ?? null,
    phase: failure?.phase ?? null, cause_code: failure?.cause_code ?? null };
}
