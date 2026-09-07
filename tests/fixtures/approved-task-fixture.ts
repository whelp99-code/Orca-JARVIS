import { vi } from "vitest";
import { taskPublicationFixture } from "./task-publication-fixture.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { TaskCandidateCertifications } from "../../src/task-candidate-certifications.js";
import { signTaskCertification } from "../../src/task-certification-proof.js";
import { ApprovedCommandExecutor } from "../../src/approved-executor.js";
import type { TaskProviderRequest } from "../../src/task-candidate-provider.js";
import type { TaskVerifierInvocation } from "../../src/task-verifier-process.js";
import { verifierKey } from "../helpers.js";

export async function approvedTaskFixture(passed = true) {
  const f = await taskPublicationFixture(); let now = f.now;
  const plan = { ...f.plan, provider: "claude" as const };
  const request = stageTaskExecution(f.db, { ...f.request, plan }, now); f.approve(request);
  const generate = vi.fn(async (input: TaskProviderRequest) => {
    input.before_spawn?.();
    const output = { execution_plan_digest: input.execution_plan_digest,
      files: [{ path: "answer.mjs", content: `export const answer = ${passed ? 42 : 41};\n` }] };
    return { output, output_bytes: Buffer.byteLength(JSON.stringify(output)) };
  });
  const verify = vi.fn(async (input: TaskVerifierInvocation) => {
    input.before_spawn();
    const invocation = new TaskCandidateCertifications(f.db).begin(input.command, input.verification_id, () => now);
    return signTaskCertification({ schema_version: 1, request: invocation.request, invocation_id: invocation.invocation_id,
      measurement: invocation.artifact.verification!, principal_id: "independent-verifier", algorithm: "Ed25519",
      issued_at: now.toISOString() }, verifierKey(f.db));
  });
  const runtime = { provider: { provider: "claude" as const, generate }, checkReady: vi.fn(async () => {}),
    certification: { key_id: "verifier-test", process: { checkReady: vi.fn(async () => {}), verify } } };
  const clock = () => now;
  const executor = new ApprovedCommandExecutor(f.db, undefined, undefined, {}, clock, undefined, undefined, undefined, runtime);
  return { ...f, plan, runtime, executor, generate, verify, clock, setNow: (value: Date) => { now = value; } };
}
