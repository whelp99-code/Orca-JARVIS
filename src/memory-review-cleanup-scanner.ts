import type { AuthorityDb } from "./db.js";
import { cleanupMemoryCandidateReviewPath } from "./memory-candidate-review-cleanup.js";
import { MemoryCandidateReviewSpool } from "./memory-candidate-review-spool.js";

export type MemoryReviewCleanupBatch = {
  readonly scanned: number;
  readonly removed: number;
  readonly failed: number;
  readonly scan_complete: boolean;
};

/** Process-local traversal; restart safely rescans persisted eligibility, never authorizes deletion. */
export class MemoryReviewCleanupScanner {
  private entries: Generator<string | undefined, void, undefined> | undefined;
  private spool: MemoryCandidateReviewSpool | undefined;
  private closed = false;
  constructor(private readonly authority: AuthorityDb, private readonly root: string) {}

  cycle(now: Date, limit = 64): MemoryReviewCleanupBatch {
    if (this.closed) throw new Error("MEMORY_REVIEW_CLEANUP_CLOSED");
    if (this.authority.db.inTransaction) throw new Error("MEMORY_REVIEW_CLEANUP_TRANSACTION_ACTIVE");
    if (!Number.isFinite(now.getTime())) throw new Error("MEMORY_REVIEW_CLEANUP_CLOCK_INVALID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("MEMORY_REVIEW_CLEANUP_LIMIT_INVALID");
    this.spool ??= new MemoryCandidateReviewSpool(this.root);
    this.entries ??= this.spool.iterateEntries();
    let scanned = 0; let removed = 0; let failed = 0;
    try {
      while (scanned < limit) {
        const entry = this.entries.next();
        if (entry.done) { this.entries = undefined; return { scanned, removed, failed, scan_complete: true }; }
        scanned++;
        if (entry.value === undefined) continue;
        try { removed += cleanupMemoryCandidateReviewPath(this.authority, this.spool, entry.value, now.getTime()); }
        catch { failed++; } // Retry on a later traversal; one invalid file must not starve other entries.
      }
      return { scanned, removed, failed, scan_complete: false };
    } catch (error) {
      this.entries?.return(); this.entries = undefined;
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    this.entries?.return(); this.entries = undefined;
  }
}
