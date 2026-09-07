import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryCandidateDispatchSpool } from "../../src/memory-candidate-dispatch-spool.js";
import { MemoryCandidateReviewSpool, memoryCandidateReviewDigest } from "../../src/memory-candidate-review-spool.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { outboxFixture } from "../fixtures/memory-outbox-fixture.js";

describe("operation-discriminated candidate dispatch", () => {
  it.each([1, 2, 3])("persists and reads the exact schema%s operation and target contract", async schema => {
    const f = await outboxFixture();
    try {
      const original = new MemoryCandidateReviewSpool(join(f.database.root, "candidate-review")).read(f.request.candidate_id);
      const core = { ...original, schema_version: schema === 3 ? 2 as const : 1 as const,
        operation: schema === 2 ? "correct" as const : "remember" as const,
        ...(schema === 3 ? { body_profile: "plain-text-v1" as const, statement: "line1\nline2" } : {}) };
      const review = { ...core, review_envelope_digest: memoryCandidateReviewDigest(core) };
      const target = { target_version_digest: `sha256:${"1".repeat(64)}`, expected_prior_digest: `sha256:${"2".repeat(64)}`,
        target_manifest_digest: `sha256:${"3".repeat(64)}`, scope_digest: `sha256:${"4".repeat(64)}`,
        expected_prior: { source_id: "wiki/example", source_version: `git:${"5".repeat(40)}`, source_digest: `sha256:${"6".repeat(64)}` } };
      const receipt = { control_request_id: "request", control_receipt_id: "receipt", command_digest: `sha256:${"7".repeat(64)}`,
        issued_at: f.request.created_at, principal_id: "principal:owner" as const, expires_at: f.request.expires_at };
      const spool = new MemoryCandidateDispatchSpool(join(f.database.root, "versioned-dispatch"));
      const published = spool.publish(review, receipt, schema === 2 ? target : undefined);
      expect(published.schema_version).toBe(schema);
      const read = spool.read(review.candidate_id);
      expect(read.schema_version).toBe(schema);
      expect(read.operation).toBe(schema === 2 ? "correct" : "remember");
      expect(read.request_id.startsWith(`memreq:pos:v${schema === 3 ? 3 : 1}:`)).toBe(true);
      if (read.operation === "correct") expect(read.expected_prior).toEqual(target.expected_prior);
      else expect("expected_prior" in read).toBe(false);
      expect(spool.publish(review, receipt, schema === 2 ? target : undefined).created).toBe(false);
      expect(() => spool.publish(review, receipt, schema === 2 ? undefined : target)).toThrow("MEMORY_DISPATCH_OPERATION_MISMATCH");
    } finally { closeMemoryDatabase(f.database); }
  });
});
