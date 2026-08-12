import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ApprovedCommandExecutor } from "../../src/approved-executor.js";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt, type ControlCommandRequestInput } from "../../src/control-plane.js";
import { RunbookEngine } from "../../src/runbook.js";
import { future, initialized as createInitialized, localKey } from "../helpers.js";

const temporaryDirectories = new Set<string>();
const initialized = async () => { const db = await createInitialized(); temporaryDirectories.add(dirname(db.filename)); const key = (db.db.prepare("SELECT public_key_pem FROM trusted_authority_keys WHERE key_id='decision-test'").get() as { public_key_pem: string }).public_key_pem; for (const name of readdirSync(tmpdir())) if (name.startsWith("jarvis-external-keys-")) { const directory = join(tmpdir(), name); try { if (readFileSync(join(directory, "decision.pub.pem"), "utf8") === key) temporaryDirectories.add(directory); } catch { /* Ignore unrelated temporary directories removed concurrently. */ } } return db; };
afterAll(() => { for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true }); });

const request = (id: string, runbookId: string, level: 0 | 1 | 2 | 3 | 4 | 5, args: Record<string, unknown>): ControlCommandRequestInput => ({ schema_version: 1, request_id: id, action: "runbook.execute", action_level: level, target: { environment: "local", runbook_id: runbookId }, args: { runbook_id: runbookId, args }, reversible: true, requested_by: "operator", requested_at: new Date().toISOString(), expires_at: future(10), nonce: `nonce-${id}` });
const approve = (db: Awaited<ReturnType<typeof initialized>>, control: ControlPlane, input: ControlCommandRequestInput): string => { const staged = control.stage(input); const now = new Date().toISOString(); const payload: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1, receipt_id: `approval-${input.request_id}`, request_id: input.request_id, decision: "approve", command_digest: staged.command_digest, signer_principal_id: "test-operator", authenticated_session_id: "action-hub", key_id: "decision-test", algorithm: "Ed25519", issued_at: now, not_before: now, expires_at: input.expires_at, nonce: `approval-${input.request_id}`, max_uses: 1, status: "issued" }; control.decide(signCommandApproval(payload, localKey(db))); return input.request_id; };

describe("approval-gated runbooks", () => {
  it("runs diagnostic and WAL runbooks only through approved command receipts", async () => {
    const db = await initialized(); const control = new ControlPlane(db); const executor = new ApprovedCommandExecutor(db);
    const diagnose = approve(db, control, request("runbook-doctor", "runtime-diagnose", 1, {})); await expect(executor.execute(diagnose)).resolves.toMatchObject({ state: "completed", result: { state: "completed", result: { doctor_ok: true } } });
    const wal = approve(db, control, request("runbook-wal", "wal-checkpoint", 2, {})); await expect(executor.execute(wal)).resolves.toMatchObject({ state: "completed", result: { runbook_id: "wal-checkpoint" } });
    expect((db.db.prepare("SELECT COUNT(*) AS count FROM runbook_executions").get() as { count: number }).count).toBe(2); db.close();
  });

  it("never invokes service control without the approved level and injected host adapter", async () => {
    const db = await initialized(); const control = new ControlPlane(db); let restarts = 0;
    const low = approve(db, control, request("daemon-low", "daemon-dead", 2, { service: "com.jmpark.orca-jarvis" })); const lowExecutor = new ApprovedCommandExecutor(db); await expect(lowExecutor.execute(low)).resolves.toMatchObject({ state: "failed", failure_code: "RUNBOOK_ACTION_LEVEL_TOO_LOW" });
    const escalated = approve(db, control, request("daemon-no-adapter", "daemon-dead", 3, { service: "com.jmpark.orca-jarvis" })); await expect(lowExecutor.execute(escalated)).resolves.toMatchObject({ state: "completed", result: { state: "escalated", result: { command_executed: false } } });
    const approved = approve(db, control, request("daemon-adapter", "daemon-dead", 3, { service: "com.jmpark.orca-jarvis" })); const hostExecutor = new ApprovedCommandExecutor(db, undefined, undefined, { restartService: async service => { restarts++; return { restarted: service === "com.jmpark.orca-jarvis" }; } }); await expect(hostExecutor.execute(approved)).resolves.toMatchObject({ state: "completed", result: { state: "completed", result: { restarted: true } } }); expect(restarts).toBe(1); db.close();
  });

  it("marks a service restart uncertain when the external effect loses its acknowledgement", async () => {
    const db = await initialized(); const control = new ControlPlane(db); const called = Promise.withResolvers<void>(); const acknowledgement = Promise.withResolvers<{ restarted: boolean }>(); let restarts = 0;
    const approved = approve(db, control, request("daemon-lost-ack", "daemon-dead", 3, { service: "com.jmpark.orca-jarvis" })); const executor = new ApprovedCommandExecutor(db, undefined, undefined, { restartService: async () => { restarts++; called.resolve(); return acknowledgement.promise; } });
    const execution = executor.execute(approved); await called.promise; acknowledgement.reject(new Error("restart acknowledgement lost")); const outcome = await execution;
    expect({ outcome: outcome.state, stored: control.list()[0]?.state, restarts }).toEqual({ outcome: "uncertain", stored: "uncertain", restarts: 1 });
    const attempt = db.db.prepare("SELECT state,error_code FROM control_effect_attempts WHERE request_id=?").get(approved) as Record<string, unknown>;
    expect(attempt).toMatchObject({ state: "uncertain", error_code: "EXTERNAL_EFFECT_UNCERTAIN" }); db.close();
  });

  it("marks a completed external effect uncertain when durable result persistence fails", async () => {
    const db = await initialized(); const control = new ControlPlane(db); const called = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); let restarts = 0;
    db.db.exec("CREATE TRIGGER test_runbook_persistence_failure BEFORE INSERT ON runbook_executions BEGIN SELECT RAISE(ABORT,'simulated post-effect persistence failure'); END"); const approved = approve(db, control, request("daemon-persistence-failure", "daemon-dead", 3, { service: "com.jmpark.orca-jarvis" })); const executor = new ApprovedCommandExecutor(db, undefined, undefined, { restartService: async () => { restarts++; called.resolve(); await release.promise; return { restarted: true }; } });
    const execution = executor.execute(approved); await called.promise; release.resolve(); const outcome = await execution;
    expect({ outcome: outcome.state, stored: control.list()[0]?.state, restarts }).toEqual({ outcome: "uncertain", stored: "uncertain", restarts: 1 });
    expect(db.db.prepare("SELECT state,error_code FROM control_effect_attempts WHERE request_id=?").get(approved)).toMatchObject({ state: "uncertain", error_code: "EXTERNAL_EFFECT_UNCERTAIN" }); db.close();
  });

  it("detects immutable built-in runbook drift", async () => {
    const db = await initialized(); const engine = new RunbookEngine(db); engine.ensureBuiltIns(); expect(() => db.db.prepare("UPDATE runbook_definitions SET spec_digest='drift' WHERE runbook_id='runtime-diagnose'").run()).toThrow("immutable runbook definition"); engine.ensureBuiltIns(); db.close();
  });
});
