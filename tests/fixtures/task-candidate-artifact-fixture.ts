import { canonicalize } from "../../src/canonical.js";
import { candidateHash } from "../../src/task-candidate-artifact-codec.js";
import { TaskCandidateArtifacts } from "../../src/task-candidate-artifacts.js";
import { ControlEffectAttempts } from "../../src/control-effect-attempts.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { taskExecutionPlanDigest } from "../../src/task-execution-plan.js";
import { verifyTaskCandidate } from "../../src/task-candidate-verification.js";
import { taskExecutionFixture } from "./task-execution-fixture.js";

export async function taskCandidateArtifactFixture(options: { wide?: boolean; twoChecks?: boolean } = {}) {
  const f = await taskExecutionFixture();
  const declarations = options.wide ? Array.from({ length: 128 }, (_, index) => ({ ...f.plan.files[index === 0 ? 0 : 1]!,
    path: `${"d".repeat(190)}/${"e".repeat(190)}/module-${index}.ts` })) : f.plan.files;
  const plan = { ...f.plan, files: declarations.map((file, index) => ({ ...file,
    before_digest: candidateHash(index === 0 ? "original" : "test") })) };
  if (options.wide) plan.verification = [{ ...plan.verification[0]!, argv: ["node", "--version"] }];
  if (options.twoChecks) plan.verification = [...plan.verification, { ...plan.verification[0]!, id: "second" }];
  const files = plan.files.map((file, index) => ({ path: file.path, content: Buffer.from(index === 0 ? "candidate" : "test") }));
  const manifest = { state: "checked" as const, execution_plan_digest: taskExecutionPlanDigest(plan),
    baseline_commit: plan.repository.baseline_commit, total_bytes: 8 + 4 * (files.length - 1),
    files: plan.files.map((file, index) => ({ path: file.path, access: file.access, digest: file.before_digest,
      bytes: index === 0 ? 8 : 4, executable: false })) };
  const repository = { ...manifest, snapshot_digest: candidateHash(canonicalize(manifest)) };
  f.approve(stageTaskExecution(f.db, { ...f.request, plan }, f.now));
  const command = f.control.claim("execute", "artifact-fixture", f.now);
  const effects = new ControlEffectAttempts(f.db);
  effects.prepareTask(command, () => f.now); effects.beginTaskInvocation(command, () => f.now);
  const measurement = await verifyTaskCandidate(plan, files, async () => ({ exit_code: 0,
    stdout_bytes: 0, stderr_bytes: 0, stdout_digest: candidateHash(""), stderr_digest: candidateHash("") }));
  return { ...f, plan, command, effects, store: new TaskCandidateArtifacts(f.db), measurement,
    input: { files, repository, provider_output_bytes: 256 } };
}
