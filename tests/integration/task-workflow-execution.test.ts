import { afterEach, expect, it, vi } from "vitest";
import { taskPublicationFixture } from "../fixtures/task-publication-fixture.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { executeTaskWorkflow } from "../../src/task-completion.js";
import { readTaskCompletion } from "../../src/task-completion-record.js";
import { TaskCandidateCertifications } from "../../src/task-candidate-certifications.js";
import { signTaskCertification } from "../../src/task-certification-proof.js";
import type { TaskProviderRequest } from "../../src/task-candidate-provider.js";
import type { TaskVerifierInvocation } from "../../src/task-verifier-process.js";
import { verifierKey } from "../helpers.js";
import { LoopGraph } from "../../src/loopgraph.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

it.each([true, false])("completes only when the approved checks pass: %s", async passed => {
  const f = await taskPublicationFixture(); cleanups.push(f.cleanup);
  const plan = { ...f.plan, provider: "claude" as const };
  f.approve(stageTaskExecution(f.db, { ...f.request, plan }, f.now));
  const command = f.control.claim("execute", "fixture", f.now);
  const generate = vi.fn(async (request: TaskProviderRequest) => {
    request.before_spawn?.();
    const output = { execution_plan_digest: request.execution_plan_digest,
      files: [{ path: "answer.mjs", content: `export const answer = ${passed ? 42 : 41};\n` }] };
    return { output, output_bytes: Buffer.byteLength(JSON.stringify(output)) };
  });
  // Signing fixture verifies orchestration; the live smoke uses a separate Node verifier and actual model.
  const verify = vi.fn(async (input: TaskVerifierInvocation) => {
    input.before_spawn();
    const invocation = new TaskCandidateCertifications(f.db).begin(command, input.verification_id, () => f.now);
    return signTaskCertification({ schema_version: 1, request: invocation.request, invocation_id: invocation.invocation_id,
      measurement: invocation.artifact.verification!, principal_id: "independent-verifier", algorithm: "Ed25519",
      issued_at: f.now.toISOString() }, verifierKey(f.db));
  });
  const input = { authority: f.db, command, provider: { provider: "claude" as const, generate }, clock: () => f.now,
    certification: { key_id: "verifier-test", process: { checkReady: async () => {}, verify } } };
  const result = await executeTaskWorkflow(input);
  expect(generate).toHaveBeenCalledOnce(); expect(verify).toHaveBeenCalledOnce();
  expect(f.git(["rev-parse", "HEAD"])).toBe(plan.repository.baseline_commit);
  if (passed) {
    expect(result.state).toBe("completed"); expect(readTaskCompletion(f.db, "execute")).toEqual(result);
    expect(new LoopGraph(f.db).get("run").state).toBe("completed");
    expect(await executeTaskWorkflow({ ...input, clock: () => new Date(command.lease_expires_at) })).toEqual(result);
  } else {
    expect(result).toMatchObject({ state: "candidate_certified", checks_passed: false, published: false });
    expect(readTaskCompletion(f.db, "execute")).toBeNull();
    expect(f.db.db.prepare("SELECT count(*) AS n FROM task_git_publications").get()).toEqual({ n: 0 });
    expect(f.control.get("execute")?.state).toBe("claimed");
    expect(new LoopGraph(f.db).get("run").state).toBe("running");
    await expect(executeTaskWorkflow(input)).rejects.toThrow();
  }
  expect(generate).toHaveBeenCalledOnce(); expect(verify).toHaveBeenCalledOnce();
});
