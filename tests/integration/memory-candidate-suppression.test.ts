import { createHash } from "node:crypto";
import { canonicalize } from "../../src/canonical.js";
import { parseSecondBrainWriteRequest } from "../../src/second-brain-write-request.js";
import { readFileSync } from "node:fs";
import { AuthorityDb } from "../../src/db.js";
import { ControlPlane, signCommandApproval } from "../../src/control-plane.js";
import { confirmMemoryCorrectionCandidate } from "../../src/memory-correction-confirmation.js";
import { MemoryTombstoneChain } from "../../src/memory-tombstone-chain.js";
import { localKey } from "../helpers.js";
import { verifiedMemoryInput } from "../fixtures/memory-candidate-fixture.js";
import { insertMemoryVerification, memoryVerificationPayload } from "../fixtures/memory-candidate-store.js";
import { expect, it, vi } from "vitest";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { hasSecondBrainWriteAuthority } from "../../src/second-brain-write-authority.js";
import { createSecondBrainWriteRequestAdapter } from "../../src/second-brain-write-adapter.js";
import { MemoryOutboxStore } from "../../src/memory-outbox-store.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { closeMemoryDatabase, memoryDatabase } from "../fixtures/memory-candidate-store.js";
import { inferredMemoryInput, memoryPolicy, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { outboxFixture, claimAction } from "../fixtures/memory-outbox-fixture.js";

it("refuses replay of a quarantined candidate without adding an idempotency row", async () => {
  const f = await memoryDatabase();
  try {
    const now = new Date(MEMORY_NOW); const store = new MemoryCandidateStore(f.authority, memoryPolicy(), () => now);
    const input = inferredMemoryInput(); const c = store.classify(input);
    const projections = new MemoryProjectionAuthority(f.authority); projections.initialize(now);
    projections.quarantineUnresolved({ kind: "dashboard_projection", id: c.candidate_id, component_id: c.candidate_id }, now);
    expect(() => store.classify(input)).toThrowError(expect.objectContaining({ code: "MEMORY_CANDIDATE_SUPPRESSED" }));
    expect(() => store.classify({ ...input, idempotency_key: "candidate:quarantined:replay" }))
      .toThrowError(expect.objectContaining({ code: "MEMORY_CANDIDATE_SUPPRESSED" }));
    expect(f.authority.db.prepare("SELECT COUNT(*) AS count FROM memory_candidate_idempotency").get()).toEqual({ count: 1 });
  } finally { closeMemoryDatabase(f); }
});

it("blocks an approved quarantined candidate at the provider adapter", async () => {
  const f = await outboxFixture();
  try {
    const base = { ...f.request };
    Reflect.deleteProperty(base, "request_id"); Reflect.deleteProperty(base, "request_digest");
    const digest = `sha256:${createHash("sha256").update("orca-jarvis/memory-write-request/v1\0").update(canonicalize(base)).digest("hex")}`;
    const request = { ...base, request_id: `memreq:pos:v1:${digest.slice(7)}`, request_digest: digest };
    expect(parseSecondBrainWriteRequest(request, f.clock.now)).toBeDefined();
    expect(hasSecondBrainWriteAuthority(f.database.authority, request, f.clock.now)).toBe(true);
    let calls = 0;
    const writer = createSecondBrainWriteRequestAdapter({ call: async () => { calls++; return { kind: "no_data", reason: "empty_result" }; },
      restart: async () => {}, close: async () => {}, diagnostics: () => [] }, f.database.authority, () => f.clock.now);
    expect(await writer.write(request)).toEqual({ kind: "invalid", code: "SECOND_BRAIN_WRITE_RESULT_INVALID" });
    expect(calls).toBe(1);
    const p = new MemoryProjectionAuthority(f.database.authority); p.initialize(f.clock.now);
    p.quarantineUnresolved({ kind: "dashboard_projection", id: request.candidate_id, component_id: request.candidate_id }, f.clock.now);
    expect(hasSecondBrainWriteAuthority(f.database.authority, request, f.clock.now)).toBe(false);
    expect(await writer.write(request)).toEqual({ kind: "invalid", code: "SECOND_BRAIN_WRITE_AUTHORITY_INVALID" });
    expect(calls).toBe(1);
  } finally { closeMemoryDatabase(f.database); }
});

it.each(["queued", "claimed"] as const)("blocks quarantine after %s before any dispatch attempt", async phase => {
  const f = await outboxFixture();
  try {
    const saga = f.service.enqueue(claimAction(f));
    const store = new MemoryOutboxStore(f.database.authority, 30_000, {
      candidate_review_spool_root: `${f.database.root}/candidate-review`,
      candidate_dispatch_spool_root: `${f.database.root}/candidate-dispatch`,
    });
    const claim = phase === "claimed" ? store.claimDispatch("worker", f.clock.now, 10_000) : undefined;
    const p = new MemoryProjectionAuthority(f.database.authority); p.initialize(f.clock.now);
    p.quarantineUnresolved({ kind: "dashboard_projection", id: f.request.candidate_id, component_id: f.request.candidate_id }, f.clock.now);
    if (phase === "queued") expect(store.claimDispatch("worker", f.clock.now, 10_000)).toBeUndefined();
    else {
      expect(claim).toBeDefined();
      expect(() => store.markDispatch(saga.outbox_id, "worker", claim!.lease_fence, f.clock.now))
        .toThrowError(expect.objectContaining({ code: "MEMORY_OUTBOX_AUTHORITY_INVALID" }));
    }
    expect(f.database.authority.db.prepare("SELECT COUNT(*) AS count FROM memory_outbox_attempts").get()).toEqual({ count: 0 });
  } finally { closeMemoryDatabase(f.database); }
});

it("blocks a candidate linked to a committed target tombstone", async () => {
  const f = await outboxFixture();
  try {
    const request = JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")).vectors.correction.request;
    const target = request.targets[0]; const projections = new MemoryProjectionAuthority(f.database.authority);
    projections.bind({ kind: "dashboard_projection", id: f.request.candidate_id, component_id: f.request.candidate_id },
      [{ target_digest: target.target_digest, source_identity_digest: target.source_identity_full,
        content_identity_digest: target.content_identity_full, citation_identity_digest: target.citation_identity_full }], f.clock.now);
    expect(hasSecondBrainWriteAuthority(f.database.authority, f.request, f.clock.now)).toBe(true);
    new MemoryTombstoneChain(f.database.authority, Buffer.alloc(32, 6)).append({
      operation: "correct", lane_id: request.lane_id, targets: request.targets,
      target_manifest_digest: request.target_manifest_digest, scope_digest: request.scope_digest,
      authority_receipt_digest: request.tombstone_chain_delta[0].authority_receipt_digest,
      payload_digest: request.delegation.payload_digest, effective_at: request.created_at });
    expect(projections.isProjectionIdSuppressed(f.request.candidate_id)).toBe(true);
    expect(hasSecondBrainWriteAuthority(f.database.authority, f.request, f.clock.now)).toBe(false);
  } finally { closeMemoryDatabase(f.database); }
});

it("holds the correction writer lock from suppression check through settlement", async () => {
  const f = await memoryDatabase(); const now = new Date(MEMORY_NOW);
  const other = new AuthorityDb(f.path); other.db.pragma("busy_timeout = 0");
  let restore: (() => void) | undefined;
  try {
    const input = verifiedMemoryInput({ operation: "correct", authority_id: "suppression-correction" });
    insertMemoryVerification(f.authority, memoryVerificationPayload(input));
    const c = new MemoryCandidateStore(f.authority, memoryPolicy(), () => now).classify(input);
    const control = new ControlPlane(f.authority);
    const command = control.stage({ schema_version: 1, request_id: "suppression-correction-command",
      action: "memory.confirm", action_level: 3, target: { candidate_id: c.candidate_id,
        candidate_digest: c.candidate_digest, classification_digest: c.classification_digest },
      args: { schema_version: 1, operation: "correct", evidence_digest: `sha256:${"b".repeat(64)}` },
      reversible: false, requested_by: "principal:owner", requested_at: now.toISOString(),
      expires_at: c.confirmation_expires_at!, nonce: "suppression-correction-command" }, now);
    control.decide(signCommandApproval({ schema_version: 1, receipt_id: "suppression-correction-receipt",
      request_id: command.request_id, decision: "approve", command_digest: command.command_digest,
      signer_principal_id: "principal:owner", authenticated_session_id: "owner-session", key_id: "decision-test",
      algorithm: "Ed25519", issued_at: now.toISOString(), not_before: now.toISOString(),
      expires_at: command.expires_at, nonce: "suppression-correction-receipt", max_uses: 1, status: "issued" }, localKey(f.authority)), now);
    const claim = control.claim(command.request_id, "correction-worker", now);
    const original = MemoryProjectionAuthority.prototype.isProjectionIdSuppressed;
    let attempted = false;
    const spy = vi.spyOn(MemoryProjectionAuthority.prototype, "isProjectionIdSuppressed").mockImplementation(function(this: MemoryProjectionAuthority, id) {
      attempted = true;
      expect(() => other.db.prepare(`INSERT INTO memory_projection_quarantine(
        projection_kind,projection_id,component_id,reason_code,detected_at) VALUES('dashboard_projection',?,?,'lineage_unresolved',?)`)
        .run(id, id, now.toISOString())).toThrow(/database is locked/);
      return original.call(this, id);
    });
    restore = () => spy.mockRestore();
    confirmMemoryCorrectionCandidate(f.authority, claim, now);
    expect(attempted).toBe(true); spy.mockRestore(); restore = undefined;
    expect(control.get(command.request_id)?.state).toBe("completed");
    new MemoryProjectionAuthority(other).quarantineUnresolved({ kind: "dashboard_projection",
      id: c.candidate_id, component_id: c.candidate_id }, now);
    expect(new MemoryProjectionAuthority(f.authority).isProjectionIdSuppressed(c.candidate_id)).toBe(true);
  } finally { restore?.(); other.close(); closeMemoryDatabase(f); }
});
