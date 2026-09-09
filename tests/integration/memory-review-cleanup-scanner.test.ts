import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { MemoryReviewCleanupScanner } from "../../src/memory-review-cleanup-scanner.js";
import { MemoryCandidateReviewSpool } from "../../src/memory-candidate-review-spool.js";
import { readMemoryCandidate } from "../../src/memory-candidate-reader.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { outboxFixture } from "../fixtures/memory-outbox-fixture.js";

it("bounds ignored entries, resumes traversal and rechecks expiry on later passes", async () => {
  const f = await outboxFixture();
  const root = `${f.database.root}/candidate-review`;
  const scanner = new MemoryReviewCleanupScanner(f.database.authority, root);
  try {
    const path = new MemoryCandidateReviewSpool(root).paths()[0]!;
    const candidate = readMemoryCandidate(f.database.authority.db, f.request.candidate_id)!;
    for (let i = 0; i < 7; i++) writeFileSync(`${root}/ignored-${i}.txt`, "x");
    mkdirSync(`${root}/ignored.json`);
    const traverse = () => {
      let scanned = 0; let removed = 0;
      for (let i = 0; i < 20; i++) {
        const result = scanner.cycle(f.clock.now, 2);
        expect(result.scanned).toBeLessThanOrEqual(2); expect(result.failed).toBe(0);
        scanned += result.scanned; removed += result.removed;
        if (result.scan_complete) return { scanned, removed };
      }
      throw new Error("traversal did not finish");
    };
    expect(traverse()).toEqual({ scanned: 9, removed: 0 });
    expect(existsSync(path)).toBe(true);
    f.clock.now = new Date(candidate.candidate_expires_at);
    expect(traverse()).toEqual({ scanned: 9, removed: 1 });
    expect(existsSync(path)).toBe(false);
    expect(readMemoryCandidate(f.database.authority.db, candidate.candidate_id)).toEqual(candidate);
    expect(f.database.authority.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { scanner.close(); closeMemoryDatabase(f.database); }
});

it("reports corrupt files, retries after repair and rejects use after close", async () => {
  const f = await outboxFixture();
  const root = `${f.database.root}/candidate-review`;
  const scanner = new MemoryReviewCleanupScanner(f.database.authority, root);
  try {
    const path = new MemoryCandidateReviewSpool(root).paths()[0]!;
    const bytes = readFileSync(path);
    const candidate = readMemoryCandidate(f.database.authority.db, f.request.candidate_id)!;
    f.clock.now = new Date(candidate.candidate_expires_at);
    expect(() => scanner.cycle(f.clock.now, 0)).toThrow("MEMORY_REVIEW_CLEANUP_LIMIT_INVALID");
    expect(() => scanner.cycle(new Date(NaN))).toThrow("MEMORY_REVIEW_CLEANUP_CLOCK_INVALID");
    writeFileSync(path, "{}");
    expect(scanner.cycle(f.clock.now)).toEqual({ scanned: 1, removed: 0, failed: 1, scan_complete: true });
    expect(existsSync(path)).toBe(true);
    writeFileSync(path, bytes);
    expect(scanner.cycle(f.clock.now)).toEqual({ scanned: 1, removed: 1, failed: 0, scan_complete: true });
    scanner.close();
    expect(() => scanner.cycle(f.clock.now)).toThrow("MEMORY_REVIEW_CLEANUP_CLOSED");
  } finally { scanner.close(); closeMemoryDatabase(f.database); }
});

it("rescans after an interrupted instance without duplicate removal", async () => {
  const f = await outboxFixture();
  const root = `${f.database.root}/candidate-review`;
  const first = new MemoryReviewCleanupScanner(f.database.authority, root);
  const restarted = new MemoryReviewCleanupScanner(f.database.authority, root);
  try {
    const path = new MemoryCandidateReviewSpool(root).paths()[0]!;
    expect(first.cycle(f.clock.now, 1)).toMatchObject({ scanned: 1, removed: 0, scan_complete: false });
    first.close();
    const candidate = readMemoryCandidate(f.database.authority.db, f.request.candidate_id)!;
    f.clock.now = new Date(candidate.candidate_expires_at);
    expect(restarted.cycle(f.clock.now)).toEqual({ scanned: 1, removed: 1, failed: 0, scan_complete: true });
    expect(existsSync(path)).toBe(false);
    expect(restarted.cycle(f.clock.now)).toEqual({ scanned: 0, removed: 0, failed: 0, scan_complete: true });
  } finally { first.close(); restarted.close(); closeMemoryDatabase(f.database); }
});
