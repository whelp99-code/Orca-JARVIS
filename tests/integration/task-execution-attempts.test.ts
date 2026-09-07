import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { ControlEffectAttempts } from "../../src/control-effect-attempts.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { taskExecutionFixture } from "../fixtures/task-execution-fixture.js";
import { LoopGraph } from "../../src/loopgraph.js";
import { taskExecutionPlanDigest } from "../../src/task-execution-plan.js";

const databases: AuthorityDb[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.db.open) db.close(); });
async function fixture() {
  const f = await taskExecutionFixture();
  databases.push(f.db);
  f.approve(stageTaskExecution(f.db, f.request, f.now));
  const command = f.control.claim(f.request.request_id, "task-worker", f.now);
  const attempts = new ControlEffectAttempts(f.db);
  const count = () => f.db.db.prepare("SELECT COUNT(*) AS n FROM control_effect_attempts").get();
  const state = () => f.db.db.prepare("SELECT state FROM control_effect_attempts WHERE request_id=?").get(command.request_id);
  return { ...f, command, attempts, count, state };
}

describe("task execution operation binding", () => {
  it.each(["prepared", "invoking", "uncertain"] as const)("blocks another signed request after reopening a %s operation", async state => {
    const f = await fixture();
    f.attempts.prepareTask(f.command, () => f.now);
    if (state !== "prepared") f.attempts.beginTaskInvocation(f.command, () => f.now);
    if (state === "uncertain") f.attempts.markTaskUncertain(f.command, f.now);
    const request = stageTaskExecution(f.db, { ...f.request, request_id: "another", nonce: "another-nonce" }, f.now);
    f.approve(request);
    const another = f.control.claim("another", "another-worker", f.now);
    const filename = f.db.filename;
    f.db.close();
    const reopened = new AuthorityDb(filename);
    databases.push(reopened);
    expect(() => new ControlEffectAttempts(reopened).prepareTask(another, () => f.now))
      .toThrow("TASK_EXECUTION_ALREADY_BOUND");
    expect(reopened.db.prepare("SELECT request_id,state FROM control_effect_attempts").all())
      .toEqual([{ request_id: "execute", state }]);
  });

  it("allows only one begin and never treats a generic receipt as task completion", async () => {
    const f = await fixture();
    const effect = f.attempts.prepareTask(f.command, () => f.now);
    expect(f.attempts.beginTaskInvocation(f.command, () => f.now)).toEqual(effect);
    expect(() => f.attempts.beginTaskInvocation(f.command, () => f.now)).toThrow("TASK_EXECUTION_INVOCATION_CONFLICT");
    expect(() => f.attempts.update("execute", "confirmed", f.now, { passed: true })).toThrow("EXTERNAL_EFFECT_ATTEMPT_MISSING");
    expect(f.state()).toEqual({ state: "invoking" });
    expect(f.control.get("execute")?.state).toBe("claimed");
    expect(new LoopGraph(f.db).get("run").state).toBe("running");
  });

  it.each(["stale_fence", "changed_args", "changed_target", "expired", "cancelled", "key_revoked", "workflow_cancelled"])(
    "rejects %s without reserving an operation", async scenario => {
      const f = await fixture();
      const command = structuredClone(f.command);
      let now = f.now;
      if (scenario === "stale_fence") command.fence++;
      if (scenario === "changed_args") {
        const plan = { ...f.plan, limits: { ...f.plan.limits, timeout_ms: 120_000 } };
        command.args = { plan, execution_plan_digest: taskExecutionPlanDigest(plan) };
      }
      if (scenario === "changed_target") command.target = { ...command.target, task_id: "other" };
      if (scenario === "expired") now = new Date(command.lease_expires_at);
      if (scenario === "cancelled") f.control.cancel({ request_id: "execute", reason: "cancel", actor: "test-operator",
        revoked_at: now.toISOString() }, now);
      if (scenario === "key_revoked") f.db.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
        .run("decision-test", "test revocation", now.toISOString());
      if (scenario === "workflow_cancelled") new LoopGraph(f.db).cancel("run", "cancel", now);
      expect(() => f.attempts.prepareTask(command, () => now)).toThrow();
      expect(f.count()).toEqual({ n: 0 });
    });

  it("rechecks authority at invocation but can record uncertainty after it expires", async () => {
    const f = await fixture();
    f.attempts.prepareTask(f.command, () => f.now);
    const expired = new Date(f.command.lease_expires_at);
    expect(() => f.attempts.beginTaskInvocation(f.command, () => expired)).toThrow("TASK_EXECUTION_AUTHORITY_INVALID");
    expect(f.state()).toEqual({ state: "prepared" });
    f.attempts.markTaskUncertain(f.command, expired);
    expect(f.state()).toEqual({ state: "uncertain" });
    expect(() => f.attempts.beginTaskInvocation(f.command, () => f.now)).toThrow("TASK_EXECUTION_INVOCATION_CONFLICT");
  });

  it("verifies the signed approval bytes instead of trusting an approved database state", async () => {
    const f = await fixture();
    const request = stageTaskExecution(f.db, { ...f.request, request_id: "forged", nonce: "forged-nonce" }, f.now);
    const source = f.db.db.prepare("SELECT payload_json FROM control_command_receipts WHERE request_id='execute'")
      .get() as { payload_json: string };
    const receipt = { ...JSON.parse(source.payload_json), receipt_id: "forged-receipt", request_id: "forged",
      command_digest: request.command_digest };
    f.db.db.prepare(`INSERT INTO control_command_receipts(
      receipt_id,request_id,decision,command_digest,signer_principal_id,authenticated_session_id,key_id,
      payload_json,signature,issued_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(receipt.receipt_id, receipt.request_id, receipt.decision, receipt.command_digest, receipt.signer_principal_id,
        receipt.authenticated_session_id, receipt.key_id, JSON.stringify(receipt), receipt.signature,
        receipt.issued_at, receipt.expires_at, f.now.toISOString());
    f.db.db.prepare("UPDATE control_command_requests SET state='approved' WHERE request_id='forged'").run();
    const forged = f.control.claim("forged", "worker", f.now);
    expect(() => f.attempts.prepareTask(forged, () => f.now)).toThrow("TASK_EXECUTION_AUTHORITY_INVALID");
    expect(f.count()).toEqual({ n: 0 });
  });

  it("refuses task effects disguised as another effect type", async () => {
    const f = await fixture();
    expect(() => f.attempts.prepare(f.command, "service.restart", f.now)).toThrow("TASK_EXECUTION_EFFECT_INVALID");
    expect(f.count()).toEqual({ n: 0 });
    f.attempts.prepare(f.command, "task.execute", f.now);
    expect(() => f.attempts.prepare(f.command, "task.execute", f.now)).toThrow("TASK_EXECUTION_ALREADY_BOUND");
  });

  it("preserves immutable operation identity and forbids ledger replay at the SQL boundary", async () => {
    const f = await fixture();
    f.attempts.prepareTask(f.command, () => f.now);
    expect(() => f.db.db.prepare("UPDATE control_effect_attempts SET task_plan_digest='other'").run())
      .toThrow("immutable task execution binding");
    expect(() => f.db.db.prepare("DELETE FROM control_effect_attempts").run()).toThrow("immutable control effect attempt");
    expect(() => f.db.db.prepare("UPDATE control_effect_attempts SET state='confirmed'").run())
      .toThrow("invalid task execution transition");
    f.attempts.beginTaskInvocation(f.command, () => f.now);
    f.attempts.markTaskUncertain(f.command, f.now);
    expect(() => f.db.db.prepare("UPDATE control_effect_attempts SET state='prepared'").run())
      .toThrow("invalid task execution transition");
  });

  it.each(["same_request", "new_request"])("rejects INSERT OR REPLACE replay using %s", async scenario => {
    const f = await fixture();
    f.attempts.prepareTask(f.command, () => f.now);
    f.attempts.beginTaskInvocation(f.command, () => f.now);
    f.attempts.markTaskUncertain(f.command, f.now);
    let command = f.command;
    if (scenario === "new_request") {
      f.approve(stageTaskExecution(f.db, { ...f.request, request_id: "replace", nonce: "replace-nonce" }, f.now));
      command = f.control.claim("replace", "replacer", f.now);
    }
    expect(() => f.db.db.prepare(`INSERT OR REPLACE INTO control_effect_attempts(
      attempt_id,request_id,receipt_id,lease_fence,effect_type,idempotency_key,state,created_at,updated_at,task_run_id,task_plan_digest
      ) SELECT attempt_id,?,?,?,'task.execute',idempotency_key,'prepared',created_at,updated_at,task_run_id,task_plan_digest
      FROM control_effect_attempts WHERE request_id='execute'`).run(command.request_id, command.receipt_id, command.fence))
      .toThrow("task execution operation already exists");
    expect(f.state()).toEqual({ state: "uncertain" });
  });

  it("prevents a non-task replacement from deleting the operation through SQLite rowid", async () => {
    const f = await fixture();
    f.attempts.prepareTask(f.command, () => f.now);
    f.approve(f.control.stage({ schema_version: 1, request_id: "projection", action: "state.project", action_level: 1,
      target: { environment: "local" }, args: {}, reversible: true, requested_by: "test-operator",
      requested_at: f.now.toISOString(), expires_at: f.workflow.budget.deadline, nonce: "projection-nonce" }, f.now));
    const command = f.control.claim("projection", "projection-worker", f.now);
    expect(() => f.db.db.prepare(`INSERT OR REPLACE INTO control_effect_attempts(
      rowid,attempt_id,request_id,receipt_id,lease_fence,effect_type,idempotency_key,state,created_at,updated_at
      ) SELECT rowid,'fresh-attempt',?,?,?,'other.effect','fresh-idempotency','prepared',created_at,updated_at
      FROM control_effect_attempts WHERE request_id='execute'`).run(command.request_id, command.receipt_id, command.fence))
      .toThrow("task execution operation already exists");
    expect(f.state()).toEqual({ state: "prepared" });
    f.attempts.prepare(command, "other.effect", f.now);
    expect(() => f.db.db.prepare(`UPDATE OR REPLACE control_effect_attempts
      SET _rowid_=(SELECT rowid FROM control_effect_attempts WHERE request_id='execute') WHERE request_id='projection'`).run())
      .toThrow("immutable task execution rowid");
    expect(f.count()).toEqual({ n: 2 });
  });
});
