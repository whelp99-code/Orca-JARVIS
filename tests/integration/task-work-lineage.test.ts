import { expect, it } from "vitest";
import { approvedTaskFixture } from "../fixtures/approved-task-fixture.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { readTaskPerformance } from "../../src/task-performance.js";
import { signCommandApproval } from "../../src/control-plane-contract.js";
import { localKey } from "../helpers.js";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { readDashboardTaskExecution } from "../../src/dashboard/task-execution-read.js";
import { readControlCommand } from "../../src/control-command-read.js";

it("keeps the deepest accepted chain readable, rejects overflow, and hides descendants after ancestor quarantine", async () => {
  const f = await approvedTaskFixture(true, { stage: false });
  try {
    let prior = stageTaskExecution(f.db, { ...f.request, plan: f.plan,
      work_lineage: { schema_version: 1, kind: "original" } }, f.now);
    const ancestor = prior;
    for (let index = 1; index <= 63; index++) {
      prior = stageTaskExecution(f.db, { ...f.request, plan: f.plan, request_id: `chain-${index}`, nonce: `chain-${index}`,
        work_lineage: { schema_version: 1, kind: "retry", prior_request_id: prior.request_id,
          prior_command_digest: prior.command_digest } }, new Date(f.now.getTime() + index));
    }
    expect(readControlCommand(f.db, prior.request_id)?.request_id).toBe(prior.request_id);
    const before = f.db.db.serialize();
    expect(() => stageTaskExecution(f.db, { ...f.request, plan: f.plan, request_id: "overflow", nonce: "overflow",
      work_lineage: { schema_version: 1, kind: "retry", prior_request_id: prior.request_id,
        prior_command_digest: prior.command_digest } }, new Date(f.now.getTime() + 64))).toThrow("TASK_WORK_LINEAGE_BINDING_INVALID");
    expect(f.db.db.serialize().equals(before)).toBe(true);
    new MemoryProjectionAuthority(f.db).quarantineUnresolved({ kind: "control_payload", id: ancestor.request_id,
      component_id: ancestor.request_id }, new Date(f.now.getTime() + 65));
    expect(readControlCommand(f.db, prior.request_id)).toBeUndefined();
  } finally { await f.cleanup(); }
});

it("does not disclose a hidden predecessor through the dependent dashboard request", async () => {
  const f = await approvedTaskFixture(true, { stage: false });
  try {
    const prior = stageTaskExecution(f.db, { ...f.request, plan: f.plan }, f.now);
    const now = new Date(f.now.getTime() + 1);
    stageTaskExecution(f.db, { ...f.request, plan: f.plan, request_id: "dependent", nonce: "dependent",
      work_lineage: { schema_version: 1, kind: "rework", prior_request_id: prior.request_id,
        prior_command_digest: prior.command_digest } }, now);
    new MemoryProjectionAuthority(f.db).quarantineUnresolved({ kind: "control_payload", id: prior.request_id,
      component_id: prior.request_id }, now);
    const before = f.db.db.serialize();
    const view = readDashboardTaskExecution(f.db, f.plan.task_id, now);
    expect(JSON.stringify(view)).not.toContain(prior.command_digest);
    expect(f.db.db.serialize().equals(before)).toBe(true);
  } finally { await f.cleanup(); }
});

it("stages and reports the relationship through separate compiled CLI processes", async () => {
  const f = await approvedTaskFixture(true, { stage: false });
  try {
    const prior = stageTaskExecution(f.db, { ...f.request, plan: f.plan,
      work_lineage: { schema_version: 1, kind: "original" } }, f.now);
    const path = join(f.root, "lineage-request.json");
    writeFileSync(path, JSON.stringify({ ...f.request, plan: f.plan, request_id: "cli-rework", nonce: "cli-rework",
      work_lineage: { schema_version: 1, kind: "rework", prior_request_id: prior.request_id,
        prior_command_digest: prior.command_digest } }));
    const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath,
      ["dist/src/cli.js", ...args, "--db", f.db.filename], { encoding: "utf8", timeout: 15000 }));
    expect(cli("control", "plan-task", path).request.args.work_lineage.kind).toBe("rework");
    const before = f.db.db.serialize();
    const result = cli("report", "task-performance", new Date(f.now.getTime() - 1).toISOString(), new Date().toISOString());
    expect(JSON.stringify(result)).toContain('"rework":1');
    expect(f.db.db.serialize().equals(before)).toBe(true);
    expect(f.generate).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});

it("executes a signed rework declaration once and attributes its verified completion", async () => {
  const f = await approvedTaskFixture(true, { stage: false });
  try {
    const prior = stageTaskExecution(f.db, { ...f.request, plan: f.plan,
      work_lineage: { schema_version: 1, kind: "original" } }, f.now);
    const now = new Date(f.now.getTime() + 1); f.setNow(now);
    const request = stageTaskExecution(f.db, { ...f.request, plan: f.plan, request_id: "rework-execute", nonce: "rework-execute",
      work_lineage: { schema_version: 1, kind: "rework", prior_request_id: prior.request_id,
        prior_command_digest: prior.command_digest } }, now);
    f.control.decide(signCommandApproval({ schema_version: 1, receipt_id: "rework-approval", request_id: request.request_id,
      decision: "approve", command_digest: request.command_digest, signer_principal_id: "test-operator",
      authenticated_session_id: "external-test-approval", key_id: "decision-test", algorithm: "Ed25519",
      issued_at: now.toISOString(), not_before: now.toISOString(), expires_at: request.expires_at,
      nonce: "rework-approval", max_uses: 1, status: "issued" }, localKey(f.db)), now);
    expect((await f.executor.execute(request.request_id, "rework-test", now)).state).toBe("completed");
    const report = readTaskPerformance(f.db, new Date(f.now.getTime() - 1).toISOString(),
      new Date(now.getTime() + 1).toISOString(), new Date(now.getTime() + 2));
    expect(report.work_lineage.verified_completions).toEqual({ original: 0, rework: 1, retry: 0, invalid_evidence: 0 });
    expect((await f.executor.execute(request.request_id, "rework-replay", now)).state).toBe("completed");
    expect(f.generate).toHaveBeenCalledTimes(1); expect(f.verify).toHaveBeenCalledTimes(1);
    f.db.revokeAuthority("verifier-test", "lineage evidence test");
    expect(readTaskPerformance(f.db, new Date(f.now.getTime() - 1).toISOString(),
      new Date(now.getTime() + 1).toISOString(), new Date(now.getTime() + 2)).work_lineage.verified_completions)
      .toEqual({ original: 0, rework: 0, retry: 0, invalid_evidence: 1 });
  } finally { await f.cleanup(); }
});

it("binds explicit original and rework declarations into separate approvals without replay writes", async () => {
  const f = await approvedTaskFixture(true, { stage: false });
  try {
    const original = stageTaskExecution(f.db, { ...f.request, plan: f.plan,
      work_lineage: { schema_version: 1, kind: "original" } }, f.now);
    const now = new Date(f.now.getTime() + 1);
    const input = { ...f.request, plan: f.plan, request_id: "rework", nonce: "rework",
      work_lineage: { schema_version: 1 as const, kind: "rework" as const,
        prior_request_id: original.request_id, prior_command_digest: original.command_digest } };
    const rework = stageTaskExecution(f.db, input, now);
    expect(rework.args.work_lineage).toEqual(input.work_lineage);
    expect(rework.state).toBe("pending");
    const before = f.db.db.serialize();
    expect(stageTaskExecution(f.db, input, now)).toEqual(rework);
    expect(() => stageTaskExecution(f.db, { ...input, work_lineage: { ...input.work_lineage, kind: "retry" } }, now))
      .toThrow("TASK_EXECUTION_REPLAY_CONFLICT");
    expect(f.db.db.serialize().equals(before)).toBe(true);
    expect(f.generate).not.toHaveBeenCalled();
    const report = readTaskPerformance(f.db, new Date(f.now.getTime() - 1).toISOString(),
      new Date(now.getTime() + 1).toISOString(), new Date(now.getTime() + 2));
    expect(report.work_lineage).toMatchObject({ counts: { original: 1, rework: 1, retry: 0, unknown: 0, invalid: 0 },
      denominator: 2, ratio: 0.5, status: "measured_declarations", outcome_measurement: "verified_completion_counts" });
  } finally { await f.cleanup(); }
});

it("rejects self, missing, changed-digest and non-preceding relationships without writes", async () => {
  const f = await approvedTaskFixture();
  try {
    const prior = f.control.get("execute")!;
    const cases = [
      { prior_request_id: "next", prior_command_digest: prior.command_digest },
      { prior_request_id: "missing", prior_command_digest: prior.command_digest },
      { prior_request_id: "execute", prior_command_digest: `sha256:${"0".repeat(64)}` },
      { prior_request_id: "execute", prior_command_digest: prior.command_digest },
    ];
    const before = f.db.db.serialize();
    for (const reference of cases) {
      expect(() => stageTaskExecution(f.db, { ...f.request, plan: f.plan, request_id: "next", nonce: "next",
        work_lineage: { schema_version: 1, kind: "rework", ...reference } }, f.now))
        .toThrow("TASK_WORK_LINEAGE_BINDING_INVALID");
    }
    expect(f.db.db.serialize().equals(before)).toBe(true);
    const report = readTaskPerformance(f.db, new Date(f.now.getTime() - 1).toISOString(),
      new Date(f.now.getTime() + 1).toISOString(), new Date(f.now.getTime() + 2));
    expect(report.work_lineage).toMatchObject({ counts: { unknown: 1 }, ratio: null, status: "incomplete_coverage" });
  } finally { await f.cleanup(); }
});
