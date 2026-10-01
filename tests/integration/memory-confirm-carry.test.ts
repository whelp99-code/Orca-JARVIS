import { describe, expect, it } from "vitest";
import { ApprovedCommandExecutor } from "../../src/approved-executor.js";
import { ControlPlane, signCommandApproval } from "../../src/control-plane.js";
import { carryNonSensitiveConfirm } from "../../src/memory-confirm-carry.js";
import { MemoryCandidateDispatchSpool } from "../../src/memory-candidate-dispatch-spool.js";
import { registerMemoryCandidateSpoolRoots } from "../../src/memory-surface-authority.js";
import { ControlReceiptSigner } from "../../src/remote-approval-signer.js";
import { outboxFixture, OUTBOX_NOW, OUTBOX_EXPIRES, type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";
import { closeMemoryDatabase, insertMemoryVerification, memoryVerificationPayload } from "../fixtures/memory-candidate-store.js";
import { memoryPolicy, verifiedMemoryInput } from "../fixtures/memory-candidate-fixture.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { localKey } from "../helpers.js";
import { join } from "node:path";

async function ready(): Promise<{ fixture: OutboxFixture; confirmId: string; signer: ControlReceiptSigner }> {
  const fixture = await outboxFixture();
  const roots = {
    review: join(fixture.database.root, "candidate-review"),
    dispatch: join(fixture.database.root, "candidate-dispatch"),
  };
  registerMemoryCandidateSpoolRoots(fixture.database.authority, {
    review_root: roots.review, dispatch_root: roots.dispatch,
  });
  const dispatch = new MemoryCandidateDispatchSpool(roots.dispatch).read(fixture.request.candidate_id);
  fixture.database.authority.db.prepare(
    `INSERT INTO memory_candidate_dispatch_publications(
      candidate_id,schema_version,operation,dispatch_spool_digest,state,published_at)
     VALUES(?,1,'remember',?,'published',?)`,
  ).run(fixture.request.candidate_id, dispatch.dispatch_spool_digest, OUTBOX_NOW.toISOString());
  const confirmId = `memui:candidate-control:v1:${"ab".repeat(32)}`;
  const control = new ControlPlane(fixture.database.authority);
  const staged = control.stage({
    schema_version: 1, request_id: confirmId, action: "memory.confirm", action_level: 3,
    target: {
      candidate_id: fixture.request.candidate_id,
      candidate_digest: fixture.request.candidate_digest,
      classification_digest: fixture.request.classification_digest,
    },
    args: {
      schema_version: 1, operation: "remember", decision: "confirm",
      content_digest: fixture.request.receipt_digest, review_spool_digest: `sha256:${"3".repeat(64)}`,
    },
    reversible: false, requested_by: "principal:owner", requested_at: OUTBOX_NOW.toISOString(),
    expires_at: "2026-08-31T03:45:00.000Z", nonce: `nonce:${confirmId}`,
  }, OUTBOX_NOW);
  control.decide(signCommandApproval({
    schema_version: 1, receipt_id: "confirm-receipt", request_id: confirmId, decision: "approve",
    command_digest: staged.command_digest, signer_principal_id: "principal:owner",
    authenticated_session_id: "owner-session", key_id: "decision-test", algorithm: "Ed25519",
    issued_at: OUTBOX_NOW.toISOString(), not_before: OUTBOX_NOW.toISOString(),
    expires_at: staged.expires_at, nonce: "confirm-receipt-nonce", max_uses: 1, status: "issued",
  }, localKey(fixture.database.authority)), OUTBOX_NOW);
  return {
    fixture, confirmId,
    signer: new ControlReceiptSigner(localKey(fixture.database.authority), "decision-test", "principal:owner"),
  };
}

describe("one owner approval carries a non-sensitive remember", () => {
  it("writes to Second Brain from the confirm approval alone", async () => {
    const { fixture, confirmId, signer } = await ready();
    try {
      const carried = carryNonSensitiveConfirm({
        authority: fixture.database.authority, requestId: confirmId, now: OUTBOX_NOW, signer,
      });
      expect(carried.carried).toBe(true);
      if (!carried.carried) return;
      const binding = new ControlPlane(fixture.database.authority).get(carried.request_id)?.args.confirm_binding as {
        approved_candidate_digest: string;
      };
      expect(binding.approved_candidate_digest).toBe(fixture.request.candidate_digest);
      const executed = await new ApprovedCommandExecutor(
        fixture.database.authority, undefined, undefined, {}, () => OUTBOX_NOW, fixture.service,
      ).execute(carried.request_id, "owner-inbox", OUTBOX_NOW);
      expect(fixture.writer.calls).toHaveLength(1);
      expect(fixture.writer.calls[0]?.candidate_digest).toBe(fixture.request.candidate_digest);
      expect(executed.state === "completed" || executed.state === "uncertain").toBe(true);
    } finally { closeMemoryDatabase(fixture.database); }
  });

  it("leaves a sensitive candidate waiting for a separate dispatch approval", async () => {
    const { fixture, signer } = await ready();
    try {
      const input = verifiedMemoryInput({
        sensitivity: "sensitive", subject: "wiki/sensitive", statement: "secret-shaped but fixture",
        authority_id: "sensitive-carry", idempotency_key: "candidate:sensitive-carry",
      });
      insertMemoryVerification(fixture.database.authority, memoryVerificationPayload(input, {
        issued_at: OUTBOX_NOW.toISOString(), not_before: OUTBOX_NOW.toISOString(), expires_at: OUTBOX_EXPIRES,
      }));
      const classified = new MemoryCandidateStore(fixture.database.authority, memoryPolicy(), () => OUTBOX_NOW).classify(input);
      const control = new ControlPlane(fixture.database.authority);
      const staged = control.stage({
        schema_version: 1, request_id: "confirm-sensitive", action: "memory.confirm", action_level: 3,
        target: {
          candidate_id: classified.candidate_id, candidate_digest: classified.candidate_digest,
          classification_digest: classified.classification_digest,
        },
        args: {
          schema_version: 1, operation: "remember", decision: "confirm",
          content_digest: classified.content_digest, review_spool_digest: `sha256:${"3".repeat(64)}`,
        },
        reversible: false, requested_by: "principal:owner", requested_at: OUTBOX_NOW.toISOString(),
        expires_at: "2026-08-31T03:45:00.000Z", nonce: "nonce-sensitive",
      }, OUTBOX_NOW);
      control.decide(signCommandApproval({
        schema_version: 1, receipt_id: "sensitive-receipt", request_id: "confirm-sensitive", decision: "approve",
        command_digest: staged.command_digest, signer_principal_id: "principal:owner",
        authenticated_session_id: "owner-session", key_id: "decision-test", algorithm: "Ed25519",
        issued_at: OUTBOX_NOW.toISOString(), not_before: OUTBOX_NOW.toISOString(),
        expires_at: staged.expires_at, nonce: "sensitive-receipt-nonce", max_uses: 1, status: "issued",
      }, localKey(fixture.database.authority)), OUTBOX_NOW);
      expect(carryNonSensitiveConfirm({
        authority: fixture.database.authority, requestId: "confirm-sensitive", now: OUTBOX_NOW, signer,
      })).toEqual({ carried: false, reason: "sensitive" });
    } finally { closeMemoryDatabase(fixture.database); }
  });

  it("refuses a candidate whose digest changed after approval", async () => {
    const { fixture, confirmId, signer } = await ready();
    try {
      const carried = carryNonSensitiveConfirm({
        authority: fixture.database.authority, requestId: confirmId, now: OUTBOX_NOW, signer,
      });
      expect(carried.carried).toBe(true);
      if (!carried.carried) return;
      const spool = join(fixture.database.root, "candidate-dispatch");
      const { readdirSync, writeFileSync } = await import("node:fs");
      const file = readdirSync(spool).find(name => name.endsWith(".json"));
      if (file === undefined) throw new Error("missing dispatch spool");
      writeFileSync(join(spool, file), "{\"tampered\":true}");
      const executed = await new ApprovedCommandExecutor(
        fixture.database.authority, undefined, undefined, {}, () => OUTBOX_NOW, fixture.service,
      ).execute(carried.request_id, "owner-inbox", OUTBOX_NOW);
      expect(executed.state).toBe("failed");
      expect(executed.failure_code).toBe("APPROVED_COMMAND_FAILED");
      expect(fixture.writer.calls).toHaveLength(0);
    } finally { closeMemoryDatabase(fixture.database); }
  });
});
