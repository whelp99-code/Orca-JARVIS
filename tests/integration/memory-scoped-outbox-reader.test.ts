import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { canonicalize } from "../../src/canonical.js";
import { memoryHash } from "../../src/memory-candidate-values.js";
import { ControlPlane } from "../../src/control-plane.js";
import { scopedOutboxFixture } from "../fixtures/scoped-outbox.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { registerMemoryScopedOutbox } from "../../src/memory-scoped-outbox.js";
import { readCurrentMemoryScopedOutbox } from "../../src/memory-scoped-outbox-reader.js";
import { hasSecondBrainWriteAuthority, hasRegisteredScopedSourceAuthority } from "../../src/second-brain-write-authority.js";
import { readApprovedMemoryScopeReview, readRegisteredMemoryScopeReview } from "../../src/memory-scope-review.js";
import { readMemoryCandidate } from "../../src/memory-candidate-reader.js";
import { MemoryScopedWriteSpool } from "../../src/memory-scoped-write-spool.js";

afterEach(() => vi.restoreAllMocks());
it("recovers exact registered V4 and V3 bytes while keeping unregistered approval paths closed", async () => {
  const f = await scopedOutboxFixture();
  try {
    const registered = registerMemoryScopedOutbox(f.options, f.claimed);
    expect(readMemoryCandidate(f.database.authority.db, f.candidate.candidate_id)?.state).toBe("queued");
    const options = { ...f.options, roots: f.dispatch.roots };
    const before = f.database.authority.db.prepare("SELECT * FROM memory_outbox").all();
    const request = readCurrentMemoryScopedOutbox(options, registered.outbox_id);
    expect(request.request_digest).toBe(registered.request_digest);
    expect(request.source_request).toEqual(f.request);
    expect(request.preparation.payload.content).toBe(f.statement);
    expect(Object.isFrozen(request)).toBe(true);
    expect(hasSecondBrainWriteAuthority(f.database.authority, f.request, f.now)).toBe(false);
    expect(hasRegisteredScopedSourceAuthority(f.database.authority, f.request, "other", f.now)).toBe(false);
    expect(() => readApprovedMemoryScopeReview(f.database.authority, f.options.proposal, f.review.request_id, f.now)).toThrow();
    expect(() => readRegisteredMemoryScopeReview(f.database.authority, f.options.proposal, f.review.request_id, "other", f.now)).toThrow();
    expect(f.database.authority.db.prepare("SELECT * FROM memory_outbox").all()).toEqual(before);
  } finally { closeMemoryDatabase(f.database); }
});
it.each(["provider", "agent", "session", "projects", "revision", "source_revoked", "review_revoked", "dispatch_revoked",
  "file", "valid_substitution", "expired", "final_read_revoked", "final_callback_source_revoked", "final_callback_expired", "rewind"])(
  "refuses current registered material after %s", async mode => {
    const f = await scopedOutboxFixture();
    try {
      const registered = registerMemoryScopedOutbox(f.options, f.claimed);
      let at = f.now, withdrawn = false, calls = 0;
      const revokeSource = () => f.database.authority.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
        .run(f.candidate.source.verification_evidence_id, "fixture withdrawal", f.now.toISOString());
      const options = { ...f.options, roots: f.dispatch.roots, clock: () => at,
        resolveWriteScope: (date: Date) => {
          calls += 1;
          if (mode === "final_callback_source_revoked" && calls === 2) revokeSource();
          if (mode === "final_callback_expired" && calls === 2) at = new Date(f.now.getTime() + 60000);
          if (mode === "rewind" && calls === 2) at = new Date(f.now.getTime() - 1);
          if (withdrawn) return undefined;
          const scope = f.options.resolveWriteScope(date)!;
          return { ...scope, ...(mode === "agent" ? { agent_id: "agent:other" } : {}),
            ...(mode === "session" ? { session_id: "session:other" } : {}),
            ...(mode === "provider" ? { provider_instance_id: "provider:other" } : {}),
            ...(mode === "projects" ? { projects: ["project:other"] } : {}),
            ...(mode === "revision" ? { policy_revision: "policy:2" } : {}) };
        } };
      if (mode === "source_revoked") revokeSource();
      if (mode === "review_revoked" || mode === "dispatch_revoked") new ControlPlane(f.database.authority).cancel({
        request_id: mode === "review_revoked" ? f.review.request_id : f.claimed.request_id,
        reason: "fixture withdrawal", actor: "principal:owner", revoked_at: f.now.toISOString() }, f.now);
      if (mode === "file") writeFileSync(`${f.options.spoolRoot}/${readdirSync(f.options.spoolRoot)[0]}`, "{}");
      if (mode === "valid_substitution") {
        const path = `${f.options.spoolRoot}/${readdirSync(f.options.spoolRoot)[0]}`;
        const value = JSON.parse(readFileSync(path, "utf8"));
        value.expires_at = new Date(Date.parse(value.expires_at) - 1).toISOString();
        delete value.request_id; delete value.request_digest;
        const digest = memoryHash("orca-jarvis/memory-scoped-write-request/v4\0", value);
        writeFileSync(path, canonicalize({ ...value, request_digest: digest, request_id: `memreq:scoped:v4:${digest.slice(7)}` }));
      }
      if (mode === "expired") at = new Date(f.now.getTime() + 60000);
      if (mode === "final_read_revoked") {
        const read = MemoryScopedWriteSpool.prototype.read; let reads = 0;
        vi.spyOn(MemoryScopedWriteSpool.prototype, "read").mockImplementation(function (this: MemoryScopedWriteSpool, key, now) {
          const value = read.call(this, key, now); if (++reads === 2) withdrawn = true; return value;
        });
      }
      const before = f.database.authority.db.prepare("SELECT * FROM memory_outbox").all();
      expect(() => readCurrentMemoryScopedOutbox(options, registered.outbox_id)).toThrow();
      expect(f.database.authority.db.prepare("SELECT * FROM memory_outbox").all()).toEqual(before);
    } finally { closeMemoryDatabase(f.database); }
  });

it.each(["missing", "changed"])("rejects a transitioned candidate when its original classification audit is %s", async mode => {
  const f = await scopedOutboxFixture();
  try {
    registerMemoryScopedOutbox(f.options, f.claimed);
    const db = f.database.authority.db;
    // Read-only corruption fixture: a temporary view masks only this connection's
    // audit reads. Main tables and their immutable triggers remain intact.
    db.exec(mode === "missing"
      ? "CREATE TEMP VIEW personal_operation_audit_events AS SELECT * FROM main.personal_operation_audit_events WHERE 0"
      : `CREATE TEMP VIEW personal_operation_audit_events AS SELECT event_id,event_type,subject_kind,subject_id,
        correlation_id,created_at,'sha256:changed' AS event_digest FROM main.personal_operation_audit_events`);
    expect(() => readMemoryCandidate(db, f.candidate.candidate_id)).toThrow("MEMORY_CANDIDATE_INTEGRITY_FAILURE");
    db.exec("DROP VIEW temp.personal_operation_audit_events");
    expect(readMemoryCandidate(db, f.candidate.candidate_id)?.state).toBe("queued");
  } finally { closeMemoryDatabase(f.database); }
});
