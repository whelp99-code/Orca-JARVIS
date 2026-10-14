import type { MemoryOutboxCycleResult } from "./memory-outbox-types.js";
import { JarvisError } from "./jarvis-error.js";
import { memoryOutboxFailure, memoryOutboxRecovered, tagMemoryOutboxFailure, type MemoryOutboxFailure } from "./memory-outbox-diagnostic.js";

/** Adapts an existing runtime tick to one bounded, non-overlapping outbox cycle. */
export class MemoryOutboxTick {
  private pending: Promise<void> | undefined;
  private stopped = false;
  private lastFailure: MemoryOutboxFailure | undefined;
  constructor(private readonly cycle: () => Promise<MemoryOutboxCycleResult>,
    private readonly reportError: (failure: MemoryOutboxFailure | null) => void,
    private readonly onChange: () => void = () => {}) {}

  tick(): void {
    if (this.stopped || this.pending !== undefined) return;
    this.pending = Promise.resolve().then(() => this.cycle()).then(result => {
      const failure = result.failure
        ?? (result.control_error === undefined ? undefined : memoryOutboxFailure(
          tagMemoryOutboxFailure("control_reconciliation", new JarvisError(result.control_error))))
        ?? (result.cleanup_error === undefined ? undefined : memoryOutboxFailure(
          tagMemoryOutboxFailure("review_cleanup", new JarvisError(result.cleanup_error))))
        ?? (result.failed === 0 ? undefined : memoryOutboxFailure(new JarvisError("MEMORY_OUTBOX_CYCLE_FAILED")));
      const requiresOwnRetry = this.lastFailure !== undefined && ["record_write_result", "dispatch",
        "claim_dispatch", "claim_reconciliation", "recover_dispatch"].includes(this.lastFailure.phase);
      const progressed = memoryOutboxRecovered(result, this.lastFailure) || (!requiresOwnRetry && (this.lastFailure?.phase === "provider_write"
        ? result.settled + result.conflicts > 0
        : result.dispatched + result.settled + result.conflicts + result.reconciling + (result.commands_reconciled ?? 0) > 0
          || (this.lastFailure?.phase === "review_cleanup" && result.cleanup_error === undefined)));
      this.report(failure, progressed);
      if (result.dispatched + result.settled + result.conflicts + result.failed + (result.commands_reconciled ?? 0) > 0) this.onChange();
    }, error => { this.report(memoryOutboxFailure(error)); }).finally(() => { this.pending = undefined; });
  }

  async drain(): Promise<void> { await this.pending; }
  async close(): Promise<void> { this.stopped = true; await this.drain(); }

  private report(failure: MemoryOutboxFailure | undefined, progressed = false): void {
    if (failure === undefined && !progressed) return;
    const same = failure?.phase === this.lastFailure?.phase && failure?.cause_code === this.lastFailure?.cause_code;
    this.lastFailure = failure;
    if (same) return;
    this.reportError(failure ?? null);
  }
}
