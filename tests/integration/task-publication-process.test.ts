import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { inspectTaskGitPublication, publishTaskGitCandidate } from "../../src/task-git-publication.js";
import { taskPublicationFixture } from "../fixtures/task-publication-fixture.js";

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
}

it.each(["before_ref", "after_ref"])("recovers the durable commit intent after a real SIGKILL at %s without replay", async mode => {
  const f = await taskPublicationFixture(); let child: ChildProcess | undefined; let reopened: AuthorityDb | undefined;
  try {
    const input = await f.certify();
    child = fork("tests/fixtures/task-publication-worker.mjs", [f.db.filename], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const [ready] = await once(child, "message"); expect(ready.state).toBe("ready");
    const boundary = once(child, "message");
    child.send({ command: input.command, verification_id: input.verification_id, now: f.now.toISOString(), mode });
    const [paused] = await boundary; expect(paused.state).toBe("paused");
    await stop(child);
    reopened = new AuthorityDb(f.db.filename);
    const before = reopened.db.prepare("SELECT total_changes() AS n").get();
    expect(await inspectTaskGitPublication(reopened, "execute")).toMatchObject({ state: "prepared", expected_commit: paused.commit,
      observation: mode === "before_ref" ? "ref_absent" : "ref_matches",
      observed_commit: mode === "before_ref" ? null : paused.commit });
    expect(reopened.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    await expect(publishTaskGitCandidate({ ...input, authority: reopened })).rejects.toThrow("TASK_PUBLICATION_ALREADY_BOUND");
    expect(f.git(["rev-parse", "HEAD"])).toBe(f.plan.repository.baseline_commit);
  } finally { if (child) await stop(child); reopened?.close(); await f.cleanup(); }
}, 20_000);
