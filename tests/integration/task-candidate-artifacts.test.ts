import { dirname } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { TaskCandidateArtifacts } from "../../src/task-candidate-artifacts.js";
import { canonicalize } from "../../src/canonical.js";
import { candidateHash } from "../../src/task-candidate-artifact-codec.js";
import { taskCandidateArtifactFixture } from "../fixtures/task-candidate-artifact-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(options: { wide?: boolean; twoChecks?: boolean } = {}) {
  const f = await taskCandidateArtifactFixture(options);
  cleanups.push(async () => { if (f.db.db.open) f.db.close(); await rm(dirname(f.db.filename), { recursive: true, force: true }); });
  return f;
}

describe("durable task candidates", () => {
  it("stores and recovers measurements for 128 declared files with long legal paths", async () => {
    const f = await fixture({ wide: true });
    expect(Buffer.byteLength(canonicalize(f.measurement))).toBeGreaterThan(32768);
    f.store.save(f.command, f.input, () => f.now);
    f.store.recordVerification(f.command, f.measurement, () => f.now);
    expect(f.store.read("execute")!.verification!.files).toHaveLength(128);
  });

  it("rejects partial PASS but records a failed prefix without requiring the unexecuted checks", async () => {
    const f = await fixture({ twoChecks: true });
    f.store.save(f.command, f.input, () => f.now);
    const incomplete = { ...f.measurement, checks: f.measurement.checks.slice(0, 1) };
    expect(() => f.store.recordVerification(f.command, incomplete, () => f.now)).toThrow("TASK_CANDIDATE_ARTIFACT_INVALID");
    const failed = { ...incomplete, state: "checks_failed", checks: [{ ...incomplete.checks[0]!, exit_code: 1 }] };
    expect(f.store.recordVerification(f.command, failed, () => f.now).verification?.state).toBe("checks_failed");
  });

  it.each(["save", "verification"])("rolls back %s if authority expires before COMMIT", async phase => {
    const f = await fixture();
    if (phase === "verification") f.store.save(f.command, f.input, () => f.now);
    let reads = 0;
    const clock = () => ++reads < 3 ? f.now : new Date(f.command.lease_expires_at);
    expect(() => phase === "save" ? f.store.save(f.command, f.input, clock)
      : f.store.recordVerification(f.command, f.measurement, clock)).toThrow("TASK_EXECUTION_AUTHORITY_INVALID");
    expect(reads).toBe(3);
    if (phase === "save") expect(f.store.read("execute")).toBeNull();
    else expect(f.store.read("execute")!.verification).toBeNull();
  });

  it("recovers committed bytes after reopening, without requiring a live lease or changing the ledger", async () => {
    const f = await fixture();
    const saved = f.store.save(f.command, f.input, () => f.now);
    expect(saved.verification).toBeNull();
    f.effects.markTaskUncertain(f.command, new Date(f.command.lease_expires_at));
    f.db.close();
    const reopened = new AuthorityDb(f.db.filename);
    try {
      const before = reopened.db.prepare("SELECT total_changes() AS n").get();
      const stored = new TaskCandidateArtifacts(reopened).read("execute")!;
      expect(stored.artifact_id).toBe(saved.artifact_id);
      expect(stored.files.map(file => file.content.toString())).toEqual(["candidate", "test"]);
      expect(stored.verification).toBeNull();
      expect(reopened.db.prepare("SELECT state FROM control_effect_attempts").get()).toEqual({ state: "uncertain" });
      expect(reopened.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    } finally { reopened.close(); }
  });

  it("records one consistent local measurement and makes exact retries read-only", async () => {
    const f = await fixture();
    f.store.save(f.command, f.input, () => f.now);
    const stored = f.store.recordVerification(f.command, f.measurement, () => f.now);
    const before = f.db.db.prepare("SELECT total_changes() AS n").get();
    expect(f.store.save(f.command, f.input, () => f.now)).toEqual(stored);
    expect(f.store.recordVerification(f.command, f.measurement, () => f.now)).toEqual(stored);
    expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(f.db.db.prepare("SELECT state FROM control_effect_attempts").get()).toEqual({ state: "invoking" });
    const changed = structuredClone(f.measurement);
    Object.assign(changed, { state: "checks_failed" }); Object.assign(changed.checks[0]!, { exit_code: 1 });
    expect(() => f.store.recordVerification(f.command, changed, () => f.now)).toThrow("TASK_CANDIDATE_ARTIFACT_CONFLICT");
  });

  it.each(["expired", "revoked", "fence", "uncertain"])("rejects %s writes without adding an artifact", async scenario => {
    const f = await fixture();
    let now = f.now;
    if (scenario === "expired") now = new Date(f.command.lease_expires_at);
    if (scenario === "revoked") f.control.cancel({ request_id: "execute", actor: "operator", reason: "cancel",
      revoked_at: now.toISOString() }, now);
    if (scenario === "uncertain") f.effects.markTaskUncertain(f.command, now);
    const command = scenario === "fence" ? { ...f.command, fence: f.command.fence + 1 } : f.command;
    expect(() => f.store.save(command, f.input, () => now)).toThrow();
    expect(f.store.read("execute")).toBeNull();
  });

  it.each(["empty", "digest", "order", "bytes", "early_pass", "extra"])("rejects %s verification evidence", async scenario => {
    const f = await fixture();
    f.store.save(f.command, f.input, () => f.now);
    const measurement = structuredClone(f.measurement);
    if (scenario === "empty") Object.assign(measurement, { checks: [] });
    if (scenario === "digest") Object.assign(measurement, { candidate_digest: candidateHash("wrong") });
    if (scenario === "order") Object.assign(measurement.checks[0]!, { id: "other" });
    if (scenario === "bytes") Object.assign(measurement.checks[0]!, { stdout_bytes: f.plan.limits.max_output_bytes });
    if (scenario === "early_pass") Object.assign(measurement, { state: "checks_failed" });
    if (scenario === "extra") Object.assign(measurement, { approved: true });
    expect(() => f.store.recordVerification(f.command, measurement, () => f.now)).toThrow("TASK_CANDIDATE_ARTIFACT_INVALID");
    expect(f.store.read("execute")!.verification).toBeNull();
  });

  it("rolls back failed candidate and verification writes while preserving the invocation", async () => {
    const f = await fixture();
    f.db.db.exec(`CREATE TRIGGER fixture_fail_candidate AFTER INSERT ON task_candidate_artifacts
      BEGIN SELECT RAISE(ABORT,'fixture interrupted'); END`);
    expect(() => f.store.save(f.command, f.input, () => f.now)).toThrow("fixture interrupted");
    expect(f.store.read("execute")).toBeNull();
    f.db.db.exec("DROP TRIGGER fixture_fail_candidate");
    f.store.save(f.command, f.input, () => f.now);
    f.db.db.exec(`CREATE TRIGGER fixture_fail_verification AFTER UPDATE ON task_candidate_artifacts
      BEGIN SELECT RAISE(ABORT,'fixture interrupted'); END`);
    expect(() => f.store.recordVerification(f.command, f.measurement, () => f.now)).toThrow("fixture interrupted");
    expect(f.store.read("execute")!.verification).toBeNull();
    expect(f.db.db.prepare("SELECT state FROM control_effect_attempts").get()).toEqual({ state: "invoking" });
  });

  it("blocks SQL replacement, deletion, identity mutation and verification reassignment", async () => {
    const f = await fixture();
    const saved = f.store.save(f.command, f.input, () => f.now);
    expect(() => f.db.db.exec("INSERT OR REPLACE INTO task_candidate_artifacts SELECT * FROM task_candidate_artifacts"))
      .toThrow("task candidate already exists");
    expect(() => f.db.db.exec("DELETE FROM task_candidate_artifacts")).toThrow("immutable task candidate");
    expect(() => f.db.db.exec("UPDATE task_candidate_artifacts SET payload=payload")).toThrow("immutable task candidate");
    f.store.recordVerification(f.command, f.measurement, () => f.now);
    expect(() => f.db.db.exec("UPDATE task_candidate_artifacts SET verification_json=NULL,verification_digest=NULL,verified_at=NULL"))
      .toThrow("single assignment");
    expect(f.store.read("execute")!.artifact_id).toBe(saved.artifact_id);
  });

  it.each(["bytes", "base64", "source"])("detects %s corruption on recovery, even without the immutable update trigger", async scenario => {
    const f = await fixture();
    f.store.save(f.command, f.input, () => f.now);
    f.db.db.exec("DROP TRIGGER task_candidate_identity_immutable");
    const row = f.db.db.prepare("SELECT payload FROM task_candidate_artifacts").get() as { payload: Buffer };
    const value = JSON.parse(row.payload.toString());
    if (scenario === "bytes") value.files[0].base64 = Buffer.from("tampered").toString("base64");
    if (scenario === "base64") value.files[0].base64 += "\n";
    if (scenario === "source") value.repository.files[0].bytes++;
    const payload = Buffer.from(canonicalize(value));
    f.db.db.prepare("UPDATE task_candidate_artifacts SET payload=?,payload_digest=?").run(payload, candidateHash(payload));
    expect(() => f.store.read("execute")).toThrow("TASK_CANDIDATE_ARTIFACT_INVALID");
  });
});
