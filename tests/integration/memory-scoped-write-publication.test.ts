import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { expect, it, vi, afterEach } from "vitest";
import { publishMemoryScopedWriteRequest, type MemoryScopedPublicationOptions } from "../../src/memory-scoped-write-publication.js";
import { MemoryScopedWriteSpool } from "../../src/memory-scoped-write-spool.js";
import { proposeMemoryCandidateScope } from "../../src/memory-candidate-scope.js";
import { stageMemoryScopeReview } from "../../src/memory-scope-review.js";
import { ControlPlane, signCommandApproval } from "../../src/control-plane.js";
import { localKey } from "../helpers.js";
import { scopedV3DispatchFixture } from "../fixtures/scoped-v3-dispatch.js";
import { closeMemoryDatabase, memoryTableCounts } from "../fixtures/memory-candidate-store.js";

afterEach(() => vi.restoreAllMocks());
async function setup() {
  const f = await scopedV3DispatchFixture();
  const scope = { owner: "principal:owner" as const, projects: ["project:a"], policy_revision: "policy:1",
    valid_until: new Date(f.now.getTime() + 30000).toISOString() };
  const proposal = proposeMemoryCandidateScope(f.database.authority, f.candidate.candidate_id, scope, f.now);
  const command = stageMemoryScopeReview(f.database.authority, proposal, f.now);
  const receipt = signCommandApproval({ schema_version: 1, receipt_id: `receipt:${command.request_id}`, request_id: command.request_id,
    decision: "approve", command_digest: command.command_digest, signer_principal_id: "principal:owner",
    authenticated_session_id: "session:fixture", key_id: "decision-test", algorithm: "Ed25519",
    issued_at: f.now.toISOString(), not_before: f.now.toISOString(), expires_at: command.expires_at,
    nonce: command.request_id, max_uses: 1, status: "issued" }, localKey(f.database.authority));
  new ControlPlane(f.database.authority).decide(receipt, f.now);
  const spoolRoot = `${f.database.root}/scoped`; mkdirSync(spoolRoot, { mode: 0o700 });
  const options: MemoryScopedPublicationOptions = { authority: f.database.authority, proposal,
    reviewRequestId: command.request_id, dispatch: f.dispatch, providerInstanceId: "provider:fixture", spoolRoot,
    clock: () => f.now, resolveWriteScope: () => ({ principal_id: scope.owner, agent_id: "agent:fixture", session_id: "session:fixture",
      provider_instance_id: "provider:fixture", method: "sb_write_request", projects: scope.projects,
      policy_revision: scope.policy_revision, valid_until: scope.valid_until }) };
  return { f, options };
}
it("publishes current approved material and retries without consuming authority or changing bytes", async () => {
  const { f, options } = await setup();
  try {
    const counts = memoryTableCounts(f.database.authority);
    const first = publishMemoryScopedWriteRequest(options); const inode = statSync(first.path).ino;
    expect(first).toMatchObject({ kind: "prepared", writes_authorized: false, created: true });
    expect(publishMemoryScopedWriteRequest(options)).toEqual({ ...first, created: false });
    expect(statSync(first.path).ino).toBe(inode);
    const request = new MemoryScopedWriteSpool(options.spoolRoot, options.providerInstanceId).read(first.idempotency_key, f.now);
    expect(request.preparation.payload.content).toBe(f.statement);
    expect(memoryTableCounts(f.database.authority)).toEqual(counts);
  } finally { closeMemoryDatabase(f.database); }
});
it.each(["revoked", "expired", "rewind", "tampered", "read_expired", "read_revoked", "read_source_revoked", "read_review_revoked"])("refuses success after publication when %s", async mode => {
  const { f, options } = await setup();
  try {
    let at = f.now; let revoked = false;
    const current = { ...options, clock: () => at, resolveWriteScope: (date: Date) => revoked ? undefined : options.resolveWriteScope(date) };
    const original = MemoryScopedWriteSpool.prototype.publish;
    vi.spyOn(MemoryScopedWriteSpool.prototype, "publish").mockImplementation(function (this: MemoryScopedWriteSpool, raw, now) {
      const result = original.call(this, raw, now);
      if (mode === "revoked") revoked = true;
      if (mode === "expired") at = new Date(f.now.getTime() + 60000);
      if (mode === "rewind") at = new Date(f.now.getTime() - 1);
      if (mode === "tampered") writeFileSync(result.path, "{}");
      return result;
    });
    if (mode.startsWith("read_")) {
      const read = MemoryScopedWriteSpool.prototype.read;
      vi.spyOn(MemoryScopedWriteSpool.prototype, "read").mockImplementation(function (this: MemoryScopedWriteSpool, key, now) {
        const value = read.call(this, key, now);
        if (mode === "read_expired") at = new Date(f.now.getTime() + 60000);
        else if (mode === "read_revoked") revoked = true;
        else if (mode === "read_source_revoked") f.database.authority.db.prepare(
          "INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
          .run(f.candidate.source.verification_evidence_id, "withdraw during read", f.now.toISOString());
        else new ControlPlane(f.database.authority).cancel({ request_id: options.reviewRequestId,
          reason: "withdraw during read", actor: "principal:owner", revoked_at: f.now.toISOString() }, f.now);
        return value;
      });
    }
    const counts = memoryTableCounts(f.database.authority);
    expect(() => publishMemoryScopedWriteRequest(current)).toThrow();
    expect(memoryTableCounts(f.database.authority)).toEqual(counts);
    expect(readdirSync(options.spoolRoot)).toHaveLength(1);
    if (mode !== "tampered") {
      vi.restoreAllMocks();
      const path = `${options.spoolRoot}/${readdirSync(options.spoolRoot)[0]}`;
      const bytes = readFileSync(path); const inode = statSync(path).ino;
      expect(publishMemoryScopedWriteRequest(options).created).toBe(false);
      expect(readFileSync(path)).toEqual(bytes); expect(statSync(path).ino).toBe(inode);
    }
  } finally { closeMemoryDatabase(f.database); }
});
