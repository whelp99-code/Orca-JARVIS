import { expect, it } from "vitest";
import { taskPublicationFixture } from "../fixtures/task-publication-fixture.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { readTaskPerformance } from "../../src/task-performance.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { signCommandApproval } from "../../src/control-plane-contract.js";
import { localKey } from "../helpers.js";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { taskExecutionPlanDigest } from "../../src/task-execution-plan.js";
import { assertTaskWorkLineage } from "../../src/task-work-lineage-binding.js";

it("compares predecessor timestamps as instants across UTC offsets", async () => {
  const f = await taskPublicationFixture();
  try {
    const prior = stageTaskExecution(f.db, { ...f.request, plan: f.plan }, f.now);
    const relation = { schema_version: 1, kind: "rework", prior_request_id: prior.request_id,
      prior_command_digest: prior.command_digest };
    const shifted = new Date(f.now.getTime() - 8 * 3600000).toISOString().replace("Z", "-08:00");
    // Same instant written with another offset is not a predecessor.
    expect(() => assertTaskWorkLineage(f.db, relation, "offset", f.plan, shifted))
      .toThrow("TASK_WORK_LINEAGE_BINDING_INVALID");
    const later = new Date(f.now.getTime() - 8 * 3600000 + 1).toISOString().replace("Z", "-08:00");
    expect(() => assertTaskWorkLineage(f.db, relation, "offset", f.plan, later)).not.toThrow();
  } finally { await f.cleanup(); }
});

it("rejects nonexistent lineage before persistence through the generic compiled control request CLI", async () => {
  const f = await taskPublicationFixture();
  try {
    const path = join(f.root, "raw-request.json");
    writeFileSync(path, JSON.stringify({ schema_version: 1, request_id: "raw-lineage", action: "task.execute", action_level: 3,
      target: { environment: "local", task_id: f.plan.task_id, run_id: f.plan.run_id },
      args: { plan: f.plan, execution_plan_digest: taskExecutionPlanDigest(f.plan), work_lineage: {
        schema_version: 1, kind: "rework", prior_request_id: "missing", prior_command_digest: `sha256:${"a".repeat(64)}` } },
      reversible: true, requested_by: "test-operator", requested_at: f.now.toISOString(),
      expires_at: new Date(f.now.getTime() + 60000).toISOString(), nonce: "raw-lineage" }));
    const before = f.db.db.serialize();
    const result = spawnSync(process.execPath, ["dist/src/cli.js", "control", "request", path, "--db", f.db.filename],
      { encoding: "utf8", timeout: 15000 });
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toContain("TASK_WORK_LINEAGE_BINDING_INVALID");
    expect(f.db.db.serialize().equals(before)).toBe(true);
  } finally { await f.cleanup(); }
});

it("rejects foreign repositories and preserves out-of-window ancestry in cohort completeness", async () => {
  const a = await taskPublicationFixture();
  const b = await taskPublicationFixture();
  try {
    const original = stageTaskExecution(a.db, { ...a.request, plan: a.plan,
      work_lineage: { schema_version: 1, kind: "original" } }, a.now);
    const relation = { schema_version: 1 as const, kind: "rework" as const,
      prior_request_id: original.request_id, prior_command_digest: original.command_digest };
    const next = new Date(a.now.getTime() + 10);
    const before = a.db.db.serialize();
    expect(a.plan.publication.repository_identity).not.toBe(b.plan.publication.repository_identity);
    expect(() => stageTaskExecution(a.db, { ...a.request, request_id: "foreign", nonce: "foreign",
      plan: { ...a.plan, repository: b.plan.repository, publication: b.plan.publication }, work_lineage: relation }, next))
      .toThrow("TASK_WORK_LINEAGE_BINDING_INVALID");
    expect(a.db.db.serialize().equals(before)).toBe(true);
    stageTaskExecution(a.db, { ...a.request, request_id: "rework-boundary", nonce: "rework-boundary",
      plan: a.plan, work_lineage: relation }, next);
    stageTaskExecution(a.db, { ...a.request, request_id: "retry-boundary", nonce: "retry-boundary",
      plan: a.plan, work_lineage: { ...relation, kind: "retry" } }, next);
    const end = new Date(next.getTime() + 1);
    const report = () => readTaskPerformance(a.db, next.toISOString(), end.toISOString(), end).work_lineage;
    expect(report()).toMatchObject({ counts: { original: 0, rework: 1, retry: 1, unknown: 0, invalid: 0 },
      denominator: 1, ratio: 1 });
    new MemoryProjectionAuthority(a.db).quarantineUnresolved({ kind: "control_payload", id: original.request_id,
      component_id: original.request_id }, end);
    expect(report()).toMatchObject({ counts: { invalid: 2 }, ratio: null, status: "invalid_lineage" });
  } finally { await a.cleanup(); await b.cleanup(); }
});

it("preserves two independently signed approvals and rejects post-approval relabeling without writes", async () => {
  const f = await taskPublicationFixture();
  try {
    const first = stageTaskExecution(f.db, { ...f.request, plan: f.plan,
      work_lineage: { schema_version: 1, kind: "original" } }, f.now);
    f.approve(first);
    const now = new Date(f.now.getTime() + 1);
    const input = { ...f.request, plan: f.plan, request_id: "approved-rework", nonce: "approved-rework",
      work_lineage: { schema_version: 1 as const, kind: "rework" as const,
        prior_request_id: first.request_id, prior_command_digest: first.command_digest } };
    const second = stageTaskExecution(f.db, input, now);
    f.control.decide(signCommandApproval({ schema_version: 1, receipt_id: "approve-rework",
      request_id: second.request_id, decision: "approve", command_digest: second.command_digest,
      signer_principal_id: "test-operator", authenticated_session_id: "boundary-test", key_id: "decision-test",
      algorithm: "Ed25519", issued_at: now.toISOString(), not_before: now.toISOString(), expires_at: second.expires_at,
      nonce: "approve-rework", max_uses: 1, status: "issued" }, localKey(f.db)), now);
    const before = f.db.db.serialize();
    expect(() => stageTaskExecution(f.db, { ...input, work_lineage: { ...input.work_lineage, kind: "retry" } }, now))
      .toThrow("TASK_EXECUTION_REPLAY_CONFLICT");
    expect(f.db.db.serialize().equals(before)).toBe(true);
    expect(f.control.get(first.request_id)?.state).toBe("approved");
    expect(f.control.get(second.request_id)?.state).toBe("approved");
  } finally { await f.cleanup(); }
});
