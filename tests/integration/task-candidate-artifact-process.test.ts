import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { TaskCandidateArtifacts } from "../../src/task-candidate-artifacts.js";
import { ControlEffectAttempts } from "../../src/control-effect-attempts.js";
import { taskCandidateArtifactFixture } from "../fixtures/task-candidate-artifact-fixture.js";

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
}
async function worker(filename: string) {
  const child = fork("tests/fixtures/task-candidate-artifact-worker.mjs", [filename], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const [ready] = await once(child, "message"); expect(ready.state).toBe("ready"); return child;
}
function send(child: ChildProcess, f: Awaited<ReturnType<typeof taskCandidateArtifactFixture>>, mode: string, alternate = false) {
  const response = once(child, "message");
  child.send({ command: f.command, mode, now: f.now.toISOString(), input: { ...f.input,
    files: f.input.files.map((file, index) => ({ path: file.path,
      base64: (alternate && index === 0 ? Buffer.from("different candidate") : file.content).toString("base64") })) } });
  return response.then(([value]) => value);
}

describe("candidate durability across actual process exits", () => {
  it.each(["saved", "before_commit"])("recovers only the committed candidate after SIGKILL at %s", async mode => {
    const f = await taskCandidateArtifactFixture();
    let child: ChildProcess | undefined;
    let reopened: AuthorityDb | undefined;
    try {
      child = await worker(f.db.filename);
      const result = await send(child, f, mode);
      expect(result.state).toBe(mode === "saved" ? "saved" : "uncommitted");
      await stop(child);
      f.db.close();
      reopened = new AuthorityDb(f.db.filename);
      const stored = new TaskCandidateArtifacts(reopened).read("execute");
      if (mode === "saved") {
        expect(stored?.artifact_id).toBe(result.artifact_id);
        expect(stored?.files[0]?.content.toString()).toBe("candidate");
        expect(stored?.verification).toBeNull();
      } else expect(stored).toBeNull();
      expect(() => new ControlEffectAttempts(reopened!).prepareTask(f.command, () => f.now)).toThrow("TASK_EXECUTION_ALREADY_BOUND");
      expect(reopened.db.prepare("SELECT state FROM control_effect_attempts").get()).toEqual({ state: "invoking" });
    } finally {
      if (child) await stop(child);
      if (f.db.db.open) f.db.close(); reopened?.close();
      await rm(dirname(f.db.filename), { recursive: true, force: true });
    }
  }, 20_000);

  it("commits one candidate when two processes race different bytes for the same operation", async () => {
    const f = await taskCandidateArtifactFixture();
    const workers: ChildProcess[] = [];
    try {
      workers.push(await worker(f.db.filename), await worker(f.db.filename));
      const results = await Promise.all(workers.map((child, index) => send(child, f, "saved", index === 1)));
      expect(results.filter(result => result.state === "saved")).toHaveLength(1);
      expect(results.filter(result => result.code === "TASK_CANDIDATE_ARTIFACT_CONFLICT")).toHaveLength(1);
      const stored = f.store.read("execute")!;
      expect(stored.candidate_digest).toBe(results.find(result => result.state === "saved").candidate_digest);
      expect(f.db.db.prepare("SELECT COUNT(*) AS n FROM task_candidate_artifacts").get()).toEqual({ n: 1 });
    } finally {
      await Promise.all(workers.map(stop)); f.db.close();
      await rm(dirname(f.db.filename), { recursive: true, force: true });
    }
  }, 20_000);
});
