import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { compileTaskTemplate, parseTaskTemplateBinding, taskTemplateCatalog } from "../../src/task-templates.js";
import { approvedTaskFixture } from "../fixtures/approved-task-fixture.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { prepareDashboardTaskExecution } from "../../src/dashboard/task-execution-service.js";
import { readTaskCompletion } from "../../src/task-completion-record.js";
import { spawnTaskSandbox } from "../../src/task-sandbox.js";
import { parseCreateTaskRequest } from "../../src/dashboard/validation.js";
import { stageDashboardTask } from "../../src/dashboard/command-service.js";
import { buildCapabilityMatrix, type CapabilityProbe } from "../../src/capabilities.js";
import { planTeamProposal } from "../../src/team-proposal.js";
import { taskSpecDigest } from "../../src/task-spec.js";

const ids = ["code-fix", "incident-report", "technical-review"] as const;
function template(id: typeof ids[number]) {
  return compileTaskTemplate({ template_id: id, revision: 1, objective: "Review the supplied answer module",
    files: id === "code-fix" ? [{ path: "answer.mjs", access: "write" }, { path: "check.mjs", access: "read" }]
      : [{ path: "answer.mjs", access: "read" }, { path: "report.json", access: "write" }],
    verification: id === "code-fix" ? [{ id: "answer", argv: ["node", "check.mjs"], cwd: ".", expected_exit: 0 }] : [] });
}
function report(id: string) {
  return { schema_version: 1, template_id: id, limitations: ["Only supplied evidence was reviewed; conclusions need review."],
    references: [{ path: "answer.mjs", quote: "export const answer = 41;" }],
    ...(id === "incident-report" ? { observations: ["The module exports 41."], hypotheses: ["Expected output may differ."],
      proposed_actions: ["Confirm the intended output before changing code."] }
      : { findings: ["The exported constant is 41."], recommendations: ["Confirm the required value."] }) };
}

it.each(ids)("executes %s through approved workflow, candidate checks, certification, publication and replay", async id => {
  const compiled = template(id);
  const f = await approvedTaskFixture(true, { stage: false, template: compiled });
  try {
    if (id !== "code-fix") f.generate.mockImplementation(async input => {
      input.before_spawn?.();
      const output = { execution_plan_digest: input.execution_plan_digest,
        files: [{ path: "report.json", content: JSON.stringify(report(id)) }] };
      return { output, output_bytes: Buffer.byteLength(JSON.stringify(output)) };
    });
    const prepared = await prepareDashboardTaskExecution(f.db, "task", { schema_version: 1, run_id: "run", provider: "claude",
      repository_root: f.root, publication_ref: f.plan.publication.ref, limits: f.plan.limits,
      verification: compiled.task_template.verification,
      files: f.plan.files.map(file => ({ path: file.path, access: file.access, exists: file.before_digest !== null })) }, f.clock);
    const staged = stageTaskExecution(f.db, { ...f.request, plan: prepared.plan }, f.now);
    expect(f.generate).not.toHaveBeenCalled(); f.approve(staged);
    expect((await f.executor.execute("execute", "template-fixture", f.now)).state).toBe("completed");
    const completion = readTaskCompletion(f.db, "execute")!;
    expect(completion.state).toBe("completed");
    const outputPath = id === "code-fix" ? "answer.mjs" : "report.json";
    const content = f.git(["show", `${completion.commit}:${outputPath}`]);
    expect(content).toContain(id === "code-fix" ? "42" : id);
    expect(f.git(["show", `${completion.commit}:unrelated.txt`])).toBe("keep baseline");
    if (id !== "code-fix") expect(f.git(["show", `${completion.commit}:answer.mjs`])).toBe(f.source.trimEnd());
    const refs = f.git(["show-ref"]);
    expect((await f.executor.execute("execute", "template-replay", f.now)).state).toBe("completed");
    expect(f.generate).toHaveBeenCalledTimes(1); expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.git(["show-ref"])).toBe(refs);
  } finally { await f.cleanup(); }
});

it("blocks generic staging with widened files or removed checks before invoking a provider", async () => {
  const f = await approvedTaskFixture(true, { stage: false, template: template("incident-report") });
  try {
    for (const plan of [{ ...f.plan, files: f.plan.files.map(file => ({ ...file, access: "write" as const })) },
      { ...f.plan, verification: [{ id: "bypass", argv: ["true"], cwd: ".", expected_exit: 0 as const }] }]) {
      expect(() => stageTaskExecution(f.db, { ...f.request, plan }, f.now)).toThrow("TASK_TEMPLATE_PLAN_MISMATCH");
    }
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.db.db.prepare("SELECT count(*) AS n FROM control_command_requests WHERE action='task.execute'").get()).toEqual({ n: 0 });
  } finally { await f.cleanup(); }
});

it.each(["removed", "revision"])("rejects %s template metadata after workflow approval", async change => {
  const f = await approvedTaskFixture(true, { stage: false, template: template("technical-review") });
  try {
    const stored = structuredClone(f.workflow.input) as any;
    if (change === "removed") delete stored.task_template;
    else stored.task_template.revision = 2;
    expect(() => f.db.db.prepare("UPDATE workflow_runs SET input_json=? WHERE run_id='run'").run(JSON.stringify(stored)))
      .toThrow("immutable workflow identity");
    expect(JSON.parse((f.db.db.prepare("SELECT input_json FROM workflow_runs WHERE run_id='run'").get() as any).input_json))
      .toEqual(f.workflow.input);
    expect(f.generate).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});

it("rejects unknown revisions, altered definitions, invalid paths and missing report checks", () => {
  const binding = template("incident-report").task_template;
  for (const changed of [{ revision: 2 }, { definition_digest: `sha256:${"a".repeat(64)}` },
    { verification: [{ id: "bypass", argv: ["true"], cwd: ".", expected_exit: 0 }] },
    { files: [{ path: "../source", access: "read" }, { path: "report.json", access: "write" }] }]) {
    expect(() => parseTaskTemplateBinding({ ...binding, ...changed })).toThrow("TASK_TEMPLATE_INVALID");
  }
});

it("catalog snapshots cannot mutate compiled report requirements", () => {
  const before = template("incident-report");
  const exposed: any = taskTemplateCatalog();
  exposed[1].sections.push("invented");
  expect(template("incident-report")).toEqual(before);
});

it("treats option-shaped report paths as data instead of Node switches", async () => {
  const compiled = compileTaskTemplate({ template_id: "incident-report", revision: 1, objective: "Analyze source",
    files: [{ path: "answer.mjs", access: "read" }, { path: "--help", access: "write" }], verification: [] });
  const result = await spawnTaskSandbox({ ...compiled.task_template.verification[0]!, timeout_ms: 10000, max_output_bytes: 65536,
    files: [{ path: "answer.mjs", content: Buffer.from("source") }, { path: "--help", content: Buffer.from("{}") }] });
  expect(result.exit_code).toBe(1);
});

it.each(["foreign", "invented", "empty", "extra"])("report sandbox rejects %s evidence", async failure => {
  const binding = template("incident-report").task_template;
  const value: any = report("incident-report");
  if (failure === "foreign") value.references[0].path = "private.txt";
  if (failure === "invented") value.references[0].quote = "not in the supplied source";
  if (failure === "empty") value.observations = [];
  if (failure === "extra") value.resolved = true;
  const result = await spawnTaskSandbox({ ...binding.verification[0]!, timeout_ms: 10000, max_output_bytes: 1024,
    files: [{ path: "answer.mjs", content: Buffer.from("export const answer = 41;\n") },
      { path: "report.json", content: Buffer.from(JSON.stringify(value)) }] });
  expect(result.exit_code).toBe(1);
});

it("stages the template in the original dashboard workflow approval and rejects missing requirements", async () => {
  const f = await approvedTaskFixture(true, { stage: false });
  try {
    const compiled = template("technical-review");
    const healthy = { ok: true, evidence: "fixture" };
    const capabilityProbe: CapabilityProbe = { inspect: async () => ({ installed: { ...healthy, version: "1.0.0" },
      configured: healthy, protocol_compatible: { ...healthy, protocol_version: "2024-11-05" }, operational: healthy, authorized: healthy }) };
    const planned = planTeamProposal(compiled.proposal_request, await buildCapabilityMatrix(f.db, capabilityProbe, f.now));
    if (planned.status !== "ready") throw Error("fixture proposal not ready");
    const request = parseCreateTaskRequest({ schema_version: 1, request_id: "template-start", nonce: "template-start",
      task_id: "template-task", run_id: "template-run", expected_proposal_digest: planned.proposal_digest,
      ...compiled, budget: f.workflow.budget });
    const staged = await stageDashboardTask({ db: f.db, now: f.now, capabilityProbe, planner: planTeamProposal, request });
    expect((staged.args.input as any).task_template).toEqual(compiled.task_template);
    expect(staged.state).toBe("pending");
    const input = staged.args.input as any;
    const spec = { ...input.task_spec, requirements: { ...input.task_spec.requirements, constraints: ["different constraints"] } };
    const changed = { ...staged.args,
      input: { ...input, task_spec: spec, task_spec_digest: taskSpecDigest(spec) } };
    expect(() => f.control.stage({ ...staged, request_id: "invalid-start", nonce: "invalid-start", args: changed }, f.now))
      .toThrow("TASK_SPEC_BINDING_INVALID");
  } finally { await f.cleanup(); }
});

it("compiled CLI emits a reusable template proposal and binding without creating an authority database", () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-template-cli-"));
  try {
    const input = join(root, "input.json");
    writeFileSync(input, JSON.stringify({ template_id: "technical-review", revision: 1, objective: "Review supplied code",
      files: [{ path: "answer.mjs", access: "read" }, { path: "report.json", access: "write" }], verification: [] }));
    const result = JSON.parse(execFileSync(process.execPath, [resolve("dist/src/cli.js"), "routing", "compile-template", input],
      { cwd: root, encoding: "utf8", timeout: 10000, env: { ...process.env, JARVIS_DB: join(root, "authority.sqlite") } }));
    expect(result.task_template.template_id).toBe("technical-review");
    expect(result.proposal_request.work_type).toBe("analysis");
    expect(readdirSync(root)).toEqual(["input.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
