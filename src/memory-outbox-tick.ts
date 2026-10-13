import type { MemoryOutboxCycleResult } from "./memory-outbox-types.js";
import { JarvisError } from "./jarvis-error.js";
import { memoryOutboxFailure, tagMemoryOutboxFailure, type MemoryOutboxFailure } from "./memory-outbox-diagnostic.js";

/** Adapts an existing runtime tick to one bounded, non-overlapping outbox cycle. */
export class MemoryOutboxTick {
  private pending: Promise<void> | undefined;
  private stopped = false;
  private lastError: string | undefined;
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
      const progressed = this.lastError?.startsWith("provider_write:") === true
        ? result.settled + result.conflicts > 0
        : result.dispatched + result.settled + result.conflicts + result.reconciling + (result.commands_reconciled ?? 0) > 0
          || (this.lastError?.startsWith("review_cleanup:") === true && result.cleanup_error === undefined);
      this.report(failure, progressed);
      if (result.dispatched + result.settled + result.conflicts + result.failed + (result.commands_reconciled ?? 0) > 0) this.onChange();
    }, error => { this.report(memoryOutboxFailure(error)); }).finally(() => { this.pending = undefined; });
  }

  async drain(): Promise<void> { await this.pending; }
  async close(): Promise<void> { this.stopped = true; await this.drain(); }

  private report(failure: MemoryOutboxFailure | undefined, progressed = false): void {
    if (failure === undefined && !progressed) return;
    const identity = failure === undefined ? undefined : `${failure.phase}:${failure.cause_code}`;
    if (identity === this.lastError) return;
    this.lastError = identity;
    this.reportError(failure ?? null);
  }
}
