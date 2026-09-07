import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ControlPlane, signCommandApproval } from "../../src/control-plane.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { MemoryCandidateReviewSpool } from "../../src/memory-candidate-review-spool.js";
import { MemoryCandidateDispatchSpool } from "../../src/memory-candidate-dispatch-spool.js";
import { cleanupMemoryCandidateReviews } from "../../src/memory-candidate-review-cleanup.js";
import { resolveSpooledDispatch } from "../../src/memory-outbox-dispatch-request.js";
import { MemoryMutationService } from "../../src/dashboard/memory-mutation-service.js";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { MEMORY_NOW, inferredMemoryInput, memoryPolicy } from "../fixtures/memory-candidate-fixture.js";
import { closeMemoryDatabase, memoryDatabase } from "../fixtures/memory-candidate-store.js";
import { localKey } from "../helpers.js";

const now = new Date(MEMORY_NOW);
async function fixture(decision: "confirm" | "reject") {
  const database = await memoryDatabase();
  const reviewRoot = join(database.root, "review");
  const dispatchRoot = join(database.root, "dispatch");
  const store = new MemoryCandidateStore(database.authority, memoryPolicy(), () => now);
  store.attachReviewSpool(reviewRoot);
  const input = inferredMemoryInput();
  const candidate = store.classify(input);
  const mutation = new MemoryMutationService({ authority: database.authority, clock: () => now,
    session: createDashboardSession("owner-session"), tokens: new MemoryTokenCache(Buffer.alloc(32, 1), () => now),
    candidate_review_spool_root: reviewRoot, candidate_dispatch_spool_root: dispatchRoot });
  const command = mutation.stageCandidateDecision({ candidate_id: candidate.candidate_id,
    operation: "remember", decision, intent_id: `memui:intent:v1:${"1".repeat(64)}` });
  if (command === undefined) throw new Error("missing confirmation command");
  const receipt = signCommandApproval({ schema_version: 1, receipt_id: "handoff-confirmation",
    request_id: command.request_id, decision: "approve", command_digest: command.command_digest,
    signer_principal_id: "principal:owner", authenticated_session_id: "owner-session", key_id: "decision-test",
    algorithm: "Ed25519", issued_at: now.toISOString(), not_before: now.toISOString(), expires_at: command.expires_at,
    nonce: "handoff-confirmation", max_uses: 1, status: "issued" }, localKey(database.authority));
  return { database, reviewRoot, dispatchRoot, input, candidate, command, receipt };
}

describe("review source handoff after real owner confirmation", () => {
  it("retains the source needed to reconstruct the approved dispatch", async () => {
    const f = await fixture("confirm");
    try {
      new ControlPlane(f.database.authority).decide(f.receipt, now);
      expect(cleanupMemoryCandidateReviews(f.database.authority, f.reviewRoot)).toBe(0);
      const dispatch = new MemoryCandidateDispatchSpool(f.dispatchRoot).read(f.candidate.candidate_id);
      const request = resolveSpooledDispatch({ candidate_id: f.candidate.candidate_id,
        dispatch_spool_digest: dispatch.dispatch_spool_digest, roots: { review: f.reviewRoot, dispatch: f.dispatchRoot }, now });
      expect(request.payload.content).toBe(f.input.statement);
      expect(request.request_digest).toBe(dispatch.request_digest);
    } finally { closeMemoryDatabase(f.database); }
  });
  it.each(["confirm", "reject"] as const)("keeps source bytes when the %s transaction rolls back", async decision => {
    const f = await fixture(decision);
    try {
      f.database.authority.db.exec(`CREATE TRIGGER fail_handoff_event BEFORE INSERT ON control_events
        WHEN NEW.event_type='control.command.approved' BEGIN SELECT RAISE(ABORT,'handoff rollback'); END`);
      expect(() => new ControlPlane(f.database.authority).decide(f.receipt, now)).toThrow("handoff rollback");
      expect(new MemoryCandidateReviewSpool(f.reviewRoot).read(f.candidate.candidate_id).statement).toBe(f.input.statement);
      expect(f.database.authority.db.prepare("SELECT state FROM memory_candidates WHERE candidate_id=?")
        .get(f.candidate.candidate_id)).toEqual({ state: "awaiting_confirmation" });
      expect(cleanupMemoryCandidateReviews(f.database.authority, f.reviewRoot)).toBe(0);
    } finally { closeMemoryDatabase(f.database); }
  });
  it("cleans committed rejection on restart and refuses cleanup inside an outer transaction", async () => {
    const f = await fixture("reject");
    try {
      new ControlPlane(f.database.authority).decide(f.receipt, now);
      expect(() => f.database.authority.db.transaction(() =>
        cleanupMemoryCandidateReviews(f.database.authority, f.reviewRoot))()).toThrow("MEMORY_REVIEW_CLEANUP_TRANSACTION_ACTIVE");
      expect(new MemoryCandidateReviewSpool(f.reviewRoot).read(f.candidate.candidate_id).statement).toBe(f.input.statement);
      expect(cleanupMemoryCandidateReviews(f.database.authority, f.reviewRoot)).toBe(1);
      expect(cleanupMemoryCandidateReviews(f.database.authority, f.reviewRoot)).toBe(0);
    } finally { closeMemoryDatabase(f.database); }
  });
  it("preserves a changed terminal envelope instead of deleting unverified bytes", async () => {
    const f = await fixture("reject");
    try {
      new ControlPlane(f.database.authority).decide(f.receipt, now);
      const path = new MemoryCandidateReviewSpool(f.reviewRoot).paths()[0];
      if (path === undefined) throw new Error("missing review source");
      const changed = readFileSync(path, "utf8").replace("concise technical", "changed technical");
      writeFileSync(path, changed);
      expect(() => cleanupMemoryCandidateReviews(f.database.authority, f.reviewRoot)).toThrow();
      expect(readFileSync(path, "utf8")).toBe(changed);
    } finally { closeMemoryDatabase(f.database); }
  });
});
