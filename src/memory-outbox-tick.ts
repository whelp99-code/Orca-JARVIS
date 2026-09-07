import type { MemoryOutboxCycleResult } from "./memory-outbox-types.js";

/** Adapts an existing runtime tick to one bounded, non-overlapping outbox cycle. */
export class MemoryOutboxTick {
  private pending: Promise<void> | undefined;
  private stopped = false;
  private lastError: string | undefined;
  constructor(private readonly cycle: () => Promise<MemoryOutboxCycleResult>,
    private readonly reportError: (code: string | null) => void,
    private readonly onChange: () => void = () => {}) {}

  tick(): void {
    if (this.stopped || this.pending !== undefined) return;
    this.pending = Promise.resolve().then(() => this.cycle()).then(result => {
      this.report(result.cleanup_error ?? (result.failed > 0 ? "MEMORY_OUTBOX_CYCLE_FAILED" : undefined));
      if (result.dispatched + result.settled + result.conflicts + result.failed > 0) this.onChange();
    }, () => { this.report("MEMORY_OUTBOX_CYCLE_FAILED"); }).finally(() => { this.pending = undefined; });
  }

  async drain(): Promise<void> { await this.pending; }
  async close(): Promise<void> { this.stopped = true; await this.drain(); }

  private report(code: string | undefined): void {
    if (code === this.lastError) return;
    this.lastError = code;
    this.reportError(code ?? null);
  }
}
