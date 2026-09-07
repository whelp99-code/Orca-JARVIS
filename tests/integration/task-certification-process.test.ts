import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { TaskCandidateCertifications } from "../../src/task-candidate-certifications.js";
import { taskCandidateArtifactFixture } from "../fixtures/task-candidate-artifact-fixture.js";

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
}

it("allows one actual verifier process to claim, preserves its original clock, and refuses replay after SIGKILL", async () => {
  const f = await taskCandidateArtifactFixture(); const children: ChildProcess[] = [];
  let reopened: AuthorityDb | undefined;
  try {
    f.store.save(f.command, f.input, () => f.now);
    const certs = new TaskCandidateCertifications(f.db);
    const request = certs.prepare(f.command, "verifier-test", () => f.now);
    for (let index = 0; index < 2; index++) {
      const child = fork("tests/fixtures/task-certification-worker.mjs", [f.db.filename], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      children.push(child);
      const [ready] = await once(child, "message"); expect(ready.state).toBe("ready");
    }
    const results = await Promise.all(children.map(async child => {
      const response = once(child, "message");
      child.send({ command: f.command, verification_id: request.verification_id, now: f.now.toISOString() });
      return (await response)[0];
    }));
    expect(results.filter(result => result.state === "running")).toHaveLength(1);
    expect(results.filter(result => result.code === "TASK_CERTIFICATION_INVOCATION_CONFLICT")).toHaveLength(1);
    const winner = results.find(result => result.state === "running");
    expect(winner.clock_id).toBe(request.clock_id);
    expect(winner.deadline_uptime_ms).toBe(request.deadline_uptime_ms);
    expect(winner.remaining_ms).toBeGreaterThan(0);
    expect(winner.remaining_ms).toBeLessThan(f.plan.limits.timeout_ms);
    await Promise.all(children.map(stop)); f.db.close();
    reopened = new AuthorityDb(f.db.filename);
    expect(reopened.db.prepare("SELECT state,invocation_id,proof_json FROM task_candidate_certifications").get())
      .toEqual({ state: "running", invocation_id: winner.invocation_id, proof_json: null });
    expect(() => new TaskCandidateCertifications(reopened!).begin(f.command, request.verification_id, () => f.now))
      .toThrow("TASK_CERTIFICATION_INVOCATION_CONFLICT");
  } finally {
    await Promise.all(children.map(stop)); if (f.db.db.open) f.db.close(); reopened?.close();
    await rm(dirname(f.db.filename), { recursive: true, force: true });
  }
}, 20_000);
