import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { canonicalize } from "../../src/canonical.js";
import { createSecondBrainWriteRequestAdapter } from "../../src/second-brain-write-adapter.js";
import type { SecondBrainTransport } from "../../src/second-brain-transport.js";
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
import { MemoryOutboxService } from "../../src/memory-outbox.js";
import { missingReader } from "../fixtures/memory-outbox-fixture.js";
import { hasOwnerConfirmedMemoryWriteAuthority } from "../../src/second-brain-write-confirmation.js";

const now = new Date(MEMORY_NOW);
async function fixture(decision: "confirm" | "reject", decidedAt = now) {
  const database = await memoryDatabase();
  const reviewRoot = join(database.root, "review");
  const dispatchRoot = join(database.root, "dispatch");
  const store = new MemoryCandidateStore(database.authority, memoryPolicy(), () => now);
  store.attachReviewSpool(reviewRoot);
  const input = inferredMemoryInput();
  const candidate = store.classify(input);
  const mutation = new MemoryMutationService({ authority: database.authority, clock: () => decidedAt,
    session: createDashboardSession("owner-session"), tokens: new MemoryTokenCache(Buffer.alloc(32, 1), () => now),
    candidate_review_spool_root: reviewRoot, candidate_dispatch_spool_root: dispatchRoot });
  const command = mutation.stageCandidateDecision({ candidate_id: candidate.candidate_id,
    operation: "remember", decision, intent_id: `memui:intent:v1:${"1".repeat(64)}` });
  if (command === undefined) throw new Error("missing confirmation command");
  const receipt = signCommandApproval({ schema_version: 1, receipt_id: "handoff-confirmation",
    request_id: command.request_id, decision: "approve", command_digest: command.command_digest,
    signer_principal_id: "principal:owner", authenticated_session_id: "owner-session", key_id: "decision-test",
    algorithm: "Ed25519", issued_at: decidedAt.toISOString(), not_before: decidedAt.toISOString(), expires_at: command.expires_at,
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
  it("dispatches the exact owner-confirmed inference after a delayed decision and rejects altered or revoked authority", async () => {
    const decidedAt = new Date(now.getTime() + 120_000);
    const f = await fixture("confirm", decidedAt);
    try {
      const control = new ControlPlane(f.database.authority);
      control.decide(f.receipt, decidedAt);
      const dispatch = new MemoryCandidateDispatchSpool(f.dispatchRoot).read(f.candidate.candidate_id);
      const request = resolveSpooledDispatch({ candidate_id: f.candidate.candidate_id,
        dispatch_spool_digest: dispatch.dispatch_spool_digest, roots: { review: f.reviewRoot, dispatch: f.dispatchRoot }, now: decidedAt });
      expect(request.expires_at).toBe(f.receipt.expires_at);
      expect(request.receipt["issued_at"]).toBe(decidedAt.toISOString());
      expect(request.created_at).toBe(now.toISOString());
      expect(hasOwnerConfirmedMemoryWriteAuthority(f.database.authority, { ...request, operation: "correct",
        expected_prior: { source_id: "wiki/other", source_version: `git:${"3".repeat(40)}`,
          source_digest: `sha256:${"4".repeat(64)}` } }, decidedAt)).toBe(false);
      const call = vi.fn<SecondBrainTransport["call"]>(async () => ({ kind: "data", value: {
        schema_version: 1, kind: "accepted", state: "pending", candidate_id: request.candidate_id,
        request_id: request.request_id, request_digest: request.request_digest, idempotency_key: request.idempotency_key,
        operation: request.operation, accepted_at: decidedAt.toISOString(),
        inbox_path: `inbox/.requests/pending/${request.request_id}.json`, request_file_digest: `sha256:${"4".repeat(64)}`, replayed: false,
      } }));
      const transport: SecondBrainTransport = { call, restart: async () => {}, close: async () => {}, diagnostics: () => [] };
      const adapter = createSecondBrainWriteRequestAdapter(transport, f.database.authority, () => decidedAt);
      for (const change of [{ subject: "Changed subject" }, { payload: { content: "Changed content" } },
        { receipt: { ...request.receipt, receipt_id: `receipt:memory:${"9".repeat(64)}` } },
        { receipt: { ...request.receipt, issued_at: now.toISOString() } }]) {
        const altered = rederive({ ...request, ...change });
        await expect(adapter.write(altered)).resolves.toEqual({ kind: "invalid", code: "SECOND_BRAIN_WRITE_AUTHORITY_INVALID" });
      }
      expect(call).not.toHaveBeenCalled();
      await expect(adapter.write(request)).resolves.toMatchObject({ kind: "accepted" });
      expect(call).toHaveBeenCalledTimes(1);
      expect(f.database.authority.db.prepare("SELECT input_class FROM memory_candidate_classifications WHERE candidate_id=?")
        .get(f.candidate.candidate_id)).toEqual({ input_class: "labeled_inference" });
      const expired = createSecondBrainWriteRequestAdapter(transport, f.database.authority, () => new Date(request.expires_at));
      await expect(expired.write(request)).resolves.toEqual({ kind: "invalid", code: "SECOND_BRAIN_WRITE_AUTHORITY_INVALID" });
      control.cancel({ request_id: f.command.request_id, reason: "owner revoked", actor: "principal:owner",
        revoked_at: decidedAt.toISOString() }, decidedAt);
      await expect(adapter.write(request)).resolves.toEqual({ kind: "invalid", code: "SECOND_BRAIN_WRITE_AUTHORITY_INVALID" });
      expect(call).toHaveBeenCalledTimes(1);
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
  it("passes an owner-confirmed candidate through the real outbox fence before a provider call", async () => {
    const f = await fixture("confirm");
    try {
      const control = new ControlPlane(f.database.authority);
      control.decide(f.receipt, now);
      const dispatch = new MemoryCandidateDispatchSpool(f.dispatchRoot).read(f.candidate.candidate_id);
      const action = control.stage({ schema_version: 1, request_id: "owner-dispatch", action: "memory.outbox.dispatch",
        action_level: 3, target: { candidate_id: f.candidate.candidate_id, candidate_digest: dispatch.candidate_digest,
          classification_digest: dispatch.classification_digest }, args: { schema_version: 2,
          dispatch_spool_digest: dispatch.dispatch_spool_digest,
          expected_artifact: { page_id: "wiki/owner-preference", sid: "12345678", source_digest: `sha256:${"3".repeat(64)}` } },
        reversible: false, requested_by: "principal:owner", requested_at: now.toISOString(),
        expires_at: f.receipt.expires_at, nonce: "owner-dispatch" }, now);
      control.decide(signCommandApproval({ schema_version: 1, receipt_id: "owner-dispatch-approval",
        request_id: action.request_id, decision: "approve", command_digest: action.command_digest,
        signer_principal_id: "principal:owner", authenticated_session_id: "owner-session", key_id: "decision-test",
        algorithm: "Ed25519", issued_at: now.toISOString(), not_before: now.toISOString(), expires_at: action.expires_at,
        nonce: "owner-dispatch-approval", max_uses: 1, status: "issued" },
      localKey(f.database.authority)), now);
      const call = vi.fn<SecondBrainTransport["call"]>(async () => ({ kind: "no_data", reason: "empty_result" }));
      const transport: SecondBrainTransport = { call, restart: async () => {}, close: async () => {}, diagnostics: () => [] };
      const service = new MemoryOutboxService({ authority: f.database.authority,
        writer: createSecondBrainWriteRequestAdapter(transport, f.database.authority, () => now), reader: missingReader(),
        clock: () => now, candidate_review_spool_root: f.reviewRoot, candidate_dispatch_spool_root: f.dispatchRoot });
      const queued = service.enqueue(control.claim(action.request_id, "owner-worker", now));
      const result = await service.runOnce("owner-worker", 1);
      expect(result.dispatched).toBe(1);
      expect(call).toHaveBeenCalledTimes(1);
      expect(service.get(queued.outbox_id)?.state).toBe("reconciling");
      // A transport without an acceptance artifact must not produce settlement.
      expect(result.settled).toBe(0);
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

function rederive(input: Record<string, unknown>): Record<string, unknown> {
  const hash = (domain: string, value: unknown) => `sha256:${createHash("sha256").update(domain).update(canonicalize(value)).digest("hex")}`;
  const base = Object.fromEntries(Object.entries({ ...input,
    receipt_digest: hash("orca-jarvis/memory-write-receipt/v1\0", input.receipt),
  }).filter(([key]) => key !== "request_id" && key !== "request_digest"));
  const requestDigest = hash("orca-jarvis/memory-write-request/v1\0", base);
  return { ...base, request_digest: requestDigest, request_id: `memreq:pos:v1:${requestDigest.slice(7)}` };
}
