import { afterEach, expect, it } from "vitest";
import { taskPublicationFixture } from "../fixtures/task-publication-fixture.js";
import { publishTaskGitCandidate } from "../../src/task-git-publication.js";
import { settleTaskExecution } from "../../src/task-completion.js";
import { readTaskCompletion } from "../../src/task-completion-record.js";
import { LoopGraph } from "../../src/loopgraph.js";
import { candidateHash } from "../../src/task-candidate-artifact-codec.js";
import { spawnSync } from "node:child_process";
import { readTaskCompletionEvidence } from "../../src/task-completion-evidence.js";
import { generateKeyPairSync } from "node:crypto";
import { canonicalize } from "../../src/canonical.js";
import { readEveningNativeSource } from "../../src/evening-native-source.js";
import { kstLocalDate } from "../../src/daily-loop-time.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { generateNativeEveningEnvelope, verifyLiveNativeEveningEnvelope, verifyNativeEveningEnvelope } from "../../src/evening-native-envelope.js";
import { signer, trustedCloseoutKey } from "../fixtures/evening-closeout.js";
import { parseStoreDetail } from "../../src/daily-loop-store-input.js";
import { closeoutHash, closeoutSigningBytes } from "../../src/evening-closeout-crypto.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const f = await taskPublicationFixture(); cleanups.push(f.cleanup);
  const input = await f.certify(); const publication = await publishTaskGitCandidate(input);
  return { ...f, input: { ...input, publication_id: publication.publication_id }, publication };
}

it("preserves native proof bytes in a signed v2 envelope and separates live validity from durable cost evidence", async () => {
  const f = await fixture(); await settleTaskExecution(f.input);
  const input = { run_id: "dlr:native-evening", correlation_id: "daily:native-evening",
    local_date: kstLocalDate(f.now), observed_at: f.now, repository_identities: [f.plan.publication.repository_identity],
    max_records: 10, max_bytes: 1048576 };
  const source = readEveningNativeSource(f.db, { local_date: input.local_date, observed_at: f.now,
    repository_identities: input.repository_identities, max_records: 10, max_bytes: 1048576 });
  const artifact = generateNativeEveningEnvelope(f.db, input, signer(f.now.toISOString()));
  expect(artifact).toMatchObject({ schema_version: 2, source_readiness: "degraded", native_completion_count: 1 });
  expect(artifact.source_json).toBe(canonicalize(source));
  expect(parseStoreDetail(artifact)).toEqual(artifact);
  // Valid deeply nested JSON must fail before recursive canonicalization or hashing.
  const deepSource = '{"schema_version":1,"local_date":"' + input.local_date + '","observed_at":"'
    + artifact.generated_at + '","state":"ready","records":[' + "[".repeat(10000) + '0'
    + "]".repeat(10000) + '],"evidence_bytes":1,"hidden_count":0,"limited":false}';
  expect(() => verifyNativeEveningEnvelope({ ...artifact, source_json: deepSource }, trustedCloseoutKey))
    .toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
  expect(() => verifyNativeEveningEnvelope({ ...artifact, source_json: "{" }, trustedCloseoutKey))
    .toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
  expect(() => verifyNativeEveningEnvelope({ ...artifact, source_json: '{"records":[1e999]}' }, trustedCloseoutKey))
    .toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
  // Synthetic opaque records exercise the outer wire format, not native proof validity.
  // Escaped quote/backslash bytes fill the legal evidence budget before source wrapping.
  const wireBoundary = (extra: number) => {
    const record = { text: '"\\'.repeat(262141) + "x".repeat(1 + extra) };
    const bytes = Buffer.byteLength(canonicalize(record));
    expect(bytes).toBe(1048576 + extra);
    const largeSource = { ...source, records: [record], evidence_bytes: bytes };
    const { artifact_id, canonical_digest, envelope, ...originalCore } = artifact;
    void artifact_id; void canonical_digest; void envelope;
    const core = { ...originalCore, source_json: canonicalize(largeSource), source_digest: closeoutHash(largeSource) };
    const digest = closeoutHash(core); const handle = signer(f.now.toISOString());
    const unsigned = { ...core, artifact_id: `evening-closeout:v2:${digest.slice(7)}`,
      canonical_digest: digest, envelope: handle.identity };
    return { ...unsigned, envelope: { ...handle.identity,
      signature: Buffer.from(handle.sign(closeoutSigningBytes("orca-jarvis/evening-closeout-native/v2\0", unsigned))).toString("base64url") } };
  };
  const boundary = wireBoundary(0);
  expect(Buffer.byteLength(boundary.source_json)).toBeGreaterThan(1048576);
  expect(Buffer.byteLength(canonicalize(boundary))).toBeGreaterThan(Buffer.byteLength(boundary.source_json));
  expect(verifyNativeEveningEnvelope(JSON.parse(JSON.stringify(boundary)), trustedCloseoutKey)).toEqual(boundary);
  expect(() => verifyNativeEveningEnvelope(wireBoundary(1), trustedCloseoutKey)).toThrow();
  expect(() => verifyLiveNativeEveningEnvelope(f.db, boundary, trustedCloseoutKey)).toThrow();
  expect(verifyLiveNativeEveningEnvelope(f.db, artifact, trustedCloseoutKey)).toEqual(artifact);
  expect(() => verifyLiveNativeEveningEnvelope(f.db, artifact, trustedCloseoutKey, new Date(f.now.getTime() - 1))).toThrow();
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { AuthorityDb } from './dist/src/db.js';
    import { verifyLiveNativeEveningEnvelope } from './dist/src/evening-native-envelope.js';
    const db = new AuthorityDb(process.argv[1]);
    try { const result = verifyLiveNativeEveningEnvelope(db, JSON.parse(process.argv[2]), JSON.parse(process.argv[3]));
      process.stdout.write(result.source_digest); } finally { db.close(); }
  `, f.db.filename, JSON.stringify(artifact), JSON.stringify(trustedCloseoutKey)], { encoding: "utf8", timeout: 10000 });
  expect(child.status).toBe(0); expect(child.stdout).toBe(artifact.source_digest);
  expect(() => verifyNativeEveningEnvelope({ ...artifact, native_completion_count: 2 }, trustedCloseoutKey)).toThrow();
  expect(() => verifyNativeEveningEnvelope(artifact, { ...trustedCloseoutKey, key_id: "wrong-key" })).toThrow();
  new MemoryProjectionAuthority(f.db).quarantineUnresolved({ kind: "control_payload", id: "execute", component_id: "execute" }, f.now);
  expect(() => verifyLiveNativeEveningEnvelope(f.db, artifact, trustedCloseoutKey)).toThrow();
  expect(verifyNativeEveningEnvelope(artifact, trustedCloseoutKey).native_completion_count).toBe(1);
});

it("collects native evening evidence within scope, byte limits and existing privacy filters", async () => {
  const f = await fixture(); const completion = await settleTaskExecution(f.input);
  const options = { local_date: kstLocalDate(f.now), observed_at: f.now,
    repository_identities: [f.plan.publication.repository_identity], max_records: 10, max_bytes: 1048576 };
  const before = f.db.db.prepare("SELECT total_changes() AS n").get();
  const source = readEveningNativeSource(f.db, options);
  expect(source).toMatchObject({ state: "ready", records: [{ completion }], hidden_count: 0, limited: false });
  expect(source.evidence_bytes).toBe(Buffer.byteLength(canonicalize(source.records[0])));
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { AuthorityDb } from './dist/src/db.js';
    import { readEveningNativeSource } from './dist/src/evening-native-source.js';
    const db = new AuthorityDb(process.argv[1]);
    const options = JSON.parse(process.argv[2]); options.observed_at = new Date(options.observed_at);
    try { const result = readEveningNativeSource(db, options);
      process.stdout.write(JSON.stringify({ state: result.state, count: result.records.length, bytes: result.evidence_bytes })); }
    finally { db.close(); }
  `, f.db.filename, JSON.stringify(options)], { encoding: "utf8", timeout: 10000 });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ state: "ready", count: 1, bytes: source.evidence_bytes });
  expect(readEveningNativeSource(f.db, { ...options, observed_at: new Date(f.now.getTime() - 1) }).records).toEqual([]);
  expect(readEveningNativeSource(f.db, { ...options, max_bytes: source.evidence_bytes }).records).toHaveLength(1);
  expect(readEveningNativeSource(f.db, { ...options, max_bytes: source.evidence_bytes - 1 }))
    .toMatchObject({ state: "partial", records: [], limited: true });
  expect(readEveningNativeSource(f.db, { ...options, repository_identities: [] }))
    .toMatchObject({ state: "no_data", records: [] });
  expect(readEveningNativeSource(f.db, { ...options, repository_identities: [`sha256:${"0".repeat(64)}`] }).records).toEqual([]);
  expect(() => readEveningNativeSource(f.db, { ...options, max_records: 0 })).toThrow("TASK_COMPLETION_INVALID");
  expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  new MemoryProjectionAuthority(f.db).quarantineUnresolved({ kind: "control_payload", id: "execute", component_id: "execute" }, f.now);
  const hidden = readEveningNativeSource(f.db, options);
  expect(hidden).toMatchObject({ state: "partial", records: [], hidden_count: 1 });
  expect(JSON.stringify(hidden)).not.toContain(completion.completion_id);
});

it("verifies original completion evidence after the execution lease expires without writes", async () => {
  const f = await fixture(); const completion = await settleTaskExecution(f.input);
  const before = f.db.db.prepare("SELECT total_changes() AS n").get();
  const evidence = readTaskCompletionEvidence(f.db, "execute", new Date(f.input.command.lease_expires_at));
  expect(evidence?.completion).toEqual(completion);
  expect(evidence?.proof.measurement.state).toBe("checks_passed");
  expect(evidence?.proof.request.verification_id).toBe(completion.verification_id);
  expect(evidence?.proof_digest).toBe(candidateHash(canonicalize(evidence?.proof)));
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { AuthorityDb } from './dist/src/db.js';
    import { readTaskCompletionEvidence } from './dist/src/task-completion-evidence.js';
    const db = new AuthorityDb(process.argv[1]);
    try { process.stdout.write(readTaskCompletionEvidence(db, 'execute', new Date(process.argv[2])).proof_digest); }
    finally { db.close(); }
  `, f.db.filename, f.input.command.lease_expires_at], { encoding: "utf8", timeout: 10000 });
  expect(child.status).toBe(0);
  expect(child.stdout).toBe(evidence?.proof_digest);
  expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  expect(() => readTaskCompletionEvidence(f.db, "execute", new Date(Date.parse(completion.completed_at) - 1)))
    .toThrow("TASK_COMPLETION_INVALID");
  expect(readTaskCompletionEvidence(f.db, "absent", f.now)).toBeNull();
});

it("rejects original completion evidence when the independent verifier key no longer matches", async () => {
  const f = await fixture(); await settleTaskExecution(f.input);
  const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  f.db.db.exec("DROP TRIGGER trusted_keys_sealed_update"); // Isolated corrupted-anchor fixture only.
  f.db.db.prepare("UPDATE trusted_authority_keys SET public_key_pem=? WHERE key_id='verifier-test'").run(key);
  expect(() => readTaskCompletionEvidence(f.db, "execute", f.now)).toThrow("TASK_COMPLETION_INVALID");
});

it("rejects revoked completion evidence without invoking execution", async () => {
  const f = await fixture(); const completion = await settleTaskExecution(f.input);
  f.db.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
    .run(completion.verification_id, "fixture revocation", f.now.toISOString());
  const before = f.db.db.prepare("SELECT total_changes() AS n").get();
  expect(() => readTaskCompletionEvidence(f.db, "execute", f.now)).toThrow("TASK_COMPLETION_INVALID");
  expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
});

it("rejects a historical completion when its stored certification bytes are lost", async () => {
  const f = await fixture(); await settleTaskExecution(f.input);
  const triggers = f.db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='task_candidate_certifications'")
    .all() as Array<{ name: string }>;
  for (const { name } of triggers) f.db.db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  f.db.db.prepare("UPDATE task_candidate_certifications SET proof_json='{}'").run();
  const before = f.db.db.prepare("SELECT total_changes() AS n").get();
  expect(() => readTaskCompletion(f.db, "execute")).toThrow("TASK_COMPLETION_INVALID");
  expect(() => readEveningNativeSource(f.db, { local_date: kstLocalDate(f.now), observed_at: f.now,
    repository_identities: [f.plan.publication.repository_identity], max_records: 10, max_bytes: 1048576 }))
    .toThrow("TASK_COMPLETION_INVALID");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { AuthorityDb } from './dist/src/db.js';
    import { readTaskCompletion } from './dist/src/task-completion-record.js';
    const db = new AuthorityDb(process.argv[1]);
    try { readTaskCompletion(db, 'execute'); process.exitCode = 1; }
    catch (error) { process.stdout.write(error.code ?? 'unexpected'); }
    finally { db.close(); }
  `, f.db.filename], { encoding: "utf8", timeout: 10000 });
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("TASK_COMPLETION_INVALID");
  expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
});

it("atomically completes the verified request, operation and built-in workflow with a read-only replay", async () => {
  const f = await fixture(); const result = await settleTaskExecution(f.input);
  expect(result).toMatchObject({ state: "completed", run_id: "run", request_id: "execute", commit: f.publication.commit,
    from_node: "observe", prior_attempts: 0, node_attempt: 1 });
  expect(f.control.get("execute")).toMatchObject({ state: "completed" });
  expect(f.db.db.prepare("SELECT lease_expires_at FROM control_command_requests WHERE request_id='execute'").get())
    .toEqual({ lease_expires_at: null });
  expect(f.db.db.prepare("SELECT state FROM control_effect_attempts").get()).toEqual({ state: "confirmed" });
  expect(new LoopGraph(f.db).get("run")).toMatchObject({ state: "completed", current_node: "complete", attempts: 1 });
  const before = f.db.db.prepare("SELECT total_changes() AS n").get();
  expect(readTaskCompletion(f.db, "execute")).toEqual(result);
  expect(await settleTaskExecution({ ...f.input, clock: () => new Date(f.input.command.lease_expires_at) })).toEqual(result);
  expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  expect(() => f.db.db.exec("UPDATE task_completions SET payload_json='{}'")).toThrow();
  expect(() => f.db.db.exec("DELETE FROM task_completions")).toThrow();
  expect(() => f.db.db.exec("INSERT OR REPLACE INTO task_completions SELECT * FROM task_completions")).toThrow();
  await expect(settleTaskExecution({ ...f.input, publication_id: "other" })).rejects.toThrow("TASK_COMPLETION_INVALID");
  await expect(settleTaskExecution({ ...f.input, command: { ...f.input.command, fence: f.input.command.fence + 1 } }))
    .rejects.toThrow("TASK_COMPLETION_INVALID");
});

it.each(["api_command", "sql_command", "sql_attempt", "sql_workflow", "graph_no_action"])(
  "blocks %s completion without a bound completion receipt", async scenario => {
    const f = await fixture();
    const action = () => {
      if (scenario === "api_command") f.control.settle("execute", f.input.command.fence,
        { state: "completed", effect_type: "claimed.success", payload: { passed: true } }, f.now);
      if (scenario === "sql_command") f.db.db.exec("UPDATE control_command_requests SET state='completed' WHERE request_id='execute'");
      if (scenario === "sql_attempt") f.db.db.exec("UPDATE control_effect_attempts SET state='confirmed'");
      if (scenario === "sql_workflow") f.db.db.exec("UPDATE workflow_runs SET state='completed' WHERE run_id='run'");
      if (scenario === "graph_no_action") {
        const graph = new LoopGraph(f.db); graph.advance({ run_id: "run", outcome: "observed", output: {} }, f.now);
        graph.advance({ run_id: "run", outcome: "no_action", output: { passed: true }, evidence_digest: candidateHash("claim") }, f.now);
      }
    };
    expect(action).toThrow("task completion receipt required");
    expect(readTaskCompletion(f.db, "execute")).toBeNull();
    expect(f.control.get("execute")?.state).toBe("claimed");
    expect(f.db.db.prepare("SELECT state FROM control_effect_attempts").get()).toEqual({ state: "invoking" });
    expect(new LoopGraph(f.db).get("run").state).not.toBe("completed");
  });

it.each(["missing", "moved", "symbolic"])("rejects an actual %s publication ref before completion", async mode => {
  const f = await fixture();
  if (mode === "missing") f.git(["update-ref", "-d", f.publication.ref]);
  if (mode === "moved") f.git(["update-ref", f.publication.ref, f.plan.repository.baseline_commit]);
  if (mode === "symbolic") f.git(["symbolic-ref", f.publication.ref, "refs/heads/missing"]);
  await expect(settleTaskExecution(f.input)).rejects.toThrow("TASK_COMPLETION_REF_CONFLICT");
  expect(readTaskCompletion(f.db, "execute")).toBeNull();
});

it.each(["cancelled", "expired", "verifier_revoked"])("rejects %s authority before settlement", async mode => {
  const f = await fixture(); let now = f.now;
  if (mode === "cancelled") f.control.cancel({ request_id: "execute", reason: "stop", revoked_by: "test-operator",
    revoked_at: now.toISOString() }, now);
  if (mode === "expired") now = new Date(f.input.command.lease_expires_at);
  if (mode === "verifier_revoked") f.db.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
    .run("verifier-test", "revoked", now.toISOString());
  await expect(settleTaskExecution({ ...f.input, clock: () => now })).rejects.toThrow();
  expect(readTaskCompletion(f.db, "execute")).toBeNull();
  expect(new LoopGraph(f.db).get("run").state).toBe("running");
});

it.each(["event_failure", "expired_at_commit", "revoked_at_commit"])("rolls every completion write back on %s", async mode => {
  const f = await fixture(); let now = f.now;
  if (mode === "event_failure") f.db.db.exec(`CREATE TRIGGER fixture_completion_fail BEFORE INSERT ON control_events
    WHEN NEW.event_type='workflow.task_completed' BEGIN SELECT RAISE(ABORT,'fixture event failure'); END`);
  if (mode === "expired_at_commit") {
    f.db.db.function("fixture_completion_expire", () => { now = new Date(f.input.command.lease_expires_at); return 1; });
    f.db.db.exec(`CREATE TRIGGER fixture_completion_expire AFTER INSERT ON control_events
      WHEN NEW.event_type='workflow.task_completed' BEGIN SELECT fixture_completion_expire(); END`);
  }
  if (mode === "revoked_at_commit") f.db.db.exec(`CREATE TRIGGER fixture_completion_revoke AFTER INSERT ON control_events
    WHEN NEW.event_type='workflow.task_completed' BEGIN INSERT INTO authority_revocations(reference,reason,created_at)
      VALUES('verifier-test','fixture',NEW.created_at); END`);
  await expect(settleTaskExecution({ ...f.input, clock: () => now })).rejects.toThrow();
  expect(readTaskCompletion(f.db, "execute")).toBeNull();
  expect(f.control.get("execute")?.state).toBe("claimed");
  expect(f.db.db.prepare("SELECT state FROM control_effect_attempts").get()).toEqual({ state: "invoking" });
  expect(new LoopGraph(f.db).get("run")).toMatchObject({ state: "running", current_node: "observe", attempts: 0 });
  expect(f.db.db.prepare("SELECT count(*) AS n FROM workflow_steps").get()).toEqual({ n: 0 });
});
