import { sign } from "node:crypto";
import { dirname } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { TaskCandidateCertifications } from "../../src/task-candidate-certifications.js";
import { signTaskCertification, verifyTaskCertification } from "../../src/task-certification-proof.js";
import { candidateHash } from "../../src/task-candidate-artifact-codec.js";
import { taskCandidateArtifactFixture } from "../fixtures/task-candidate-artifact-fixture.js";
import { localKey, untrustedKey, verifierKey } from "../helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const f = await taskCandidateArtifactFixture({ twoChecks: true });
  cleanups.push(async () => { if (f.db.db.open) f.db.close(); await rm(dirname(f.db.filename), { recursive: true, force: true }); });
  f.store.save(f.command, f.input, () => f.now);
  f.store.recordVerification(f.command, f.measurement, () => f.now);
  const certifications = new TaskCandidateCertifications(f.db);
  const request = certifications.prepare(f.command, "verifier-test", () => f.now);
  const begin = () => certifications.begin(f.command, request.verification_id, () => f.now);
  const signed = (invocation: string, measurement = f.measurement) => signTaskCertification({ schema_version: 1,
    request, invocation_id: invocation, measurement, principal_id: "independent-verifier", algorithm: "Ed25519",
    issued_at: f.now.toISOString() }, verifierKey(f.db));
  const row = () => f.db.db.prepare("SELECT state,invocation_id,proof_json FROM task_candidate_certifications").get();
  return { ...f, certifications, request, begin, signed, row };
}

describe("independent candidate certifications", () => {
  it("records signed evidence once with read-only replay, without declaring execution complete", async () => {
    const f = await fixture(); const invocation = f.begin().invocation_id; const proof = f.signed(invocation);
    expect(f.certifications.record(f.command, f.request.verification_id, invocation, proof, () => f.now)).toEqual(proof);
    const before = f.db.db.prepare("SELECT total_changes() AS n").get();
    expect(f.certifications.record(f.command, f.request.verification_id, invocation, proof, () => f.now)).toEqual(proof);
    expect(f.certifications.requireProof(f.command, f.request.verification_id, () => f.now)).toEqual(proof);
    expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(f.db.db.prepare("SELECT state FROM control_effect_attempts").get()).toEqual({ state: "invoking" });
    expect(f.control.get("execute")!.state).toBe("claimed");
  });

  it("preserves failed-check evidence separately from a successful signature validation", async () => {
    const f = await fixture(); const invocation = f.begin().invocation_id;
    const failed = { ...f.measurement, state: "checks_failed" as const,
      checks: [{ ...f.measurement.checks[0]!, exit_code: 1 }] };
    f.certifications.record(f.command, f.request.verification_id, invocation, f.signed(invocation, failed), () => f.now);
    expect(f.row()).toMatchObject({ state: "recorded" });
    expect(f.certifications.requireProof(f.command, f.request.verification_id, () => f.now).measurement.state).toBe("checks_failed");
  });

  it.each(["signature", "domain", "key", "nonce", "candidate", "receipt", "fence", "task", "partial", "empty", "future", "extra"])(
    "rejects %s substitution without storing evidence", async scenario => {
      const f = await fixture(); const invocation = f.begin().invocation_id;
      const proof = structuredClone(f.signed(invocation));
      const { signature: omitted, ...payload } = proof; void omitted;
      if (scenario === "signature") Object.assign(proof, { signature: "A".repeat(86) });
      if (scenario === "domain") Object.assign(proof, { signature: sign(null, Buffer.from(canonicalize(payload)), verifierKey(f.db)).toString("base64url") });
      if (scenario === "key") Object.assign(proof, { signature: signTaskCertification(payload, untrustedKey()).signature });
      if (scenario === "nonce") Object.assign(proof, { invocation_id: "other" });
      if (scenario === "candidate") Object.assign(proof.measurement, { candidate_digest: candidateHash("other") });
      if (scenario === "receipt") Object.assign(proof.request, { receipt_id: "other" });
      if (scenario === "fence") Object.assign(proof.request, { fence: f.command.fence + 1 });
      if (scenario === "task") Object.assign(proof.request, { task_id: "other" });
      if (scenario === "partial") Object.assign(proof.measurement, { checks: proof.measurement.checks.slice(0, 1) });
      if (scenario === "empty") Object.assign(proof.measurement, { checks: [] });
      if (scenario === "future") Object.assign(proof, { issued_at: new Date(f.now.getTime() + 1).toISOString() });
      if (scenario === "extra") Object.assign(proof, { approved: true });
      // Re-sign semantic tampering with the trusted key, so schema/binding checks must reject it independently.
      const value = ["signature", "domain", "key"].includes(scenario) ? proof
        : signTaskCertification((({ signature: ignored, ...rest }) => { void ignored; return rest; })(proof), verifierKey(f.db));
      expect(() => f.certifications.record(f.command, f.request.verification_id, invocation, value, () => f.now)).toThrow();
      expect(f.row()).toMatchObject({ state: "running", proof_json: null });
    });

  it("rejects repeated reservation/claim and prevents a losing claimant from stopping the winner", async () => {
    const f = await fixture(); const invocation = f.begin().invocation_id;
    expect(() => f.certifications.prepare(f.command, "verifier-test", () => f.now)).toThrow("TASK_CERTIFICATION_ALREADY_BOUND");
    expect(() => f.begin()).toThrow("TASK_CERTIFICATION_INVOCATION_CONFLICT");
    expect(() => f.certifications.uncertain(f.command, f.request.verification_id, "loser")).toThrow();
    expect(f.row()).toMatchObject({ state: "running", invocation_id: invocation });
  });

  it.each(["key", "verification", "invocation", "request", "artifact", "cancel", "expired"])(
    "rejects %s invalidation at consumption", async scenario => {
      const f = await fixture(); const invocation = f.begin().invocation_id;
      f.certifications.record(f.command, f.request.verification_id, invocation, f.signed(invocation), () => f.now);
      const references: Record<string, string> = { key: "verifier-test", verification: f.request.verification_id, invocation,
        request: candidateHash(canonicalize(f.request)), artifact: f.request.artifact_id };
      const reference = references[scenario];
      if (reference) f.db.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
        .run(reference, "test revoke", f.now.toISOString());
      if (scenario === "cancel") f.control.cancel({ request_id: "execute", actor: "operator", reason: "cancel",
        revoked_at: f.now.toISOString() }, f.now);
      const clock = () => scenario === "expired" ? new Date(f.command.lease_expires_at) : f.now;
      expect(() => f.certifications.requireProof(f.command, f.request.verification_id, clock)).toThrow();
    });

  it("rejects a decision key registered under a distinct verifier key ID", async () => {
    const f = await fixture();
    const pem = localKey(f.db).export({ format: "pem", type: "pkcs8" });
    // Trusted-key import must not make a different textual identity into an independent authority.
    const { createPublicKey } = await import("node:crypto");
    f.db.db.exec("DROP TRIGGER trusted_keys_sealed_update"); // Simulate a misprovisioned/corrupted anchor store.
    f.db.db.prepare("UPDATE trusted_authority_keys SET public_key_pem=? WHERE key_id='verifier-test'")
      .run(createPublicKey(pem).export({ format: "pem", type: "spki" }));
    expect(() => f.begin()).toThrow("TASK_CERTIFICATION_BINDING_INVALID");
  });

  it("rolls back certification if the lease expires after writing but before COMMIT", async () => {
    const f = await fixture(); const invocation = f.begin().invocation_id;
    let now = f.now;
    f.db.db.function("expire_fixture_clock", () => { now = new Date(f.command.lease_expires_at); return 1; });
    f.db.db.exec(`CREATE TRIGGER fixture_expire_cert AFTER UPDATE OF proof_json ON task_candidate_certifications
      BEGIN SELECT expire_fixture_clock(); END`);
    expect(() => f.certifications.record(f.command, f.request.verification_id, invocation, f.signed(invocation), () => now)).toThrow();
    expect(f.row()).toMatchObject({ state: "running", proof_json: null });
    f.certifications.uncertain(f.command, f.request.verification_id, invocation);
    expect(f.row()).toMatchObject({ state: "uncertain" });
    expect(() => f.begin()).toThrow();
  });

  it("rejects malformed wall time even for an otherwise valid proof", async () => {
    const f = await fixture(); const context = f.begin();
    expect(() => verifyTaskCertification(f.signed(context.invocation_id), f.request, context.invocation_id,
      context.encoded, context.publicKey, f.now.toISOString(), new Date(NaN))).toThrow("TASK_CERTIFICATION_PROOF_INVALID");
  });

  it("binds the persistent deadline once and blocks SQL resets or certification replacement", async () => {
    const f = await fixture();
    expect(f.db.db.prepare("SELECT task_clock_id,task_deadline_uptime_ms FROM control_effect_attempts").get())
      .toEqual({ task_clock_id: f.request.clock_id, task_deadline_uptime_ms: f.request.deadline_uptime_ms });
    expect(() => f.db.db.exec("UPDATE control_effect_attempts SET task_deadline_uptime_ms=task_deadline_uptime_ms+1000"))
      .toThrow("immutable task invocation clock");
    expect(() => f.db.db.exec("INSERT OR REPLACE INTO task_candidate_certifications SELECT * FROM task_candidate_certifications"))
      .toThrow("task certification already exists");
    expect(() => f.db.db.exec("DELETE FROM task_candidate_certifications")).toThrow("immutable task certification");
    expect(() => f.db.db.exec("UPDATE task_candidate_certifications SET request_json=request_json")).toThrow();
    const invocation = f.begin().invocation_id;
    expect(() => f.db.db.exec("UPDATE task_candidate_certifications SET state='reserved',invocation_id=NULL,started_at=NULL"))
      .toThrow("invalid task certification transition");
    f.certifications.record(f.command, f.request.verification_id, invocation, f.signed(invocation), () => f.now);
    expect(() => f.db.db.exec("UPDATE task_candidate_certifications SET proof_json=proof_json")).toThrow("invalid task certification transition");
  });
});
