import { fork } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { ControlEffectAttempts } from "../../src/control-effect-attempts.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { taskExecutionFixture } from "../fixtures/task-execution-fixture.js";

describe("task operation across real processes", () => {
  it("admits one signed request and preserves the invocation fence after the winner exits", async () => {
    const f = await taskExecutionFixture();
    const workers: ReturnType<typeof fork>[] = [];
    let reopened: AuthorityDb | undefined;
    try {
      const commands = ["first", "second", "after-exit"].map(request_id => {
        f.approve(stageTaskExecution(f.db, { ...f.request, request_id, nonce: `nonce:${request_id}` }, f.now));
        return f.control.claim(request_id, `worker:${request_id}`, f.now);
      });
      const ready = commands.slice(0, 2).map(() => {
        const child = fork("tests/fixtures/task-execution-attempt-worker.mjs", [f.db.filename], {
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        workers.push(child);
        return once(child, "message");
      });
      const readyMessages = await Promise.all(ready);
      expect(readyMessages.map(([value]) => value.state)).toEqual(["ready", "ready"]);
      expect(readyMessages[0]?.[0].pid).not.toBe(readyMessages[1]?.[0].pid);
      const results = workers.map(child => once(child, "message"));
      workers.forEach((child, index) => child.send({ command: commands[index], now: f.now.toISOString() }));
      const outcomes = (await Promise.all(results)).map(([value]) => value);
      expect(outcomes.filter(value => value.state === "invoking")).toHaveLength(1);
      expect(outcomes.filter(value => value.code === "TASK_EXECUTION_ALREADY_BOUND")).toHaveLength(1);
      const winner = outcomes.find(value => value.state === "invoking");
      expect(f.db.db.prepare("SELECT request_id,state FROM control_effect_attempts").all())
        .toEqual([{ request_id: winner.request_id, state: "invoking" }]);
      // An abrupt process exit has no acknowledgement or automatic release of the durable invocation.
      const exits = workers.map(child => once(child, "exit"));
      workers.forEach(child => child.kill("SIGKILL"));
      await Promise.all(exits);
      const filename = f.db.filename;
      f.db.close();
      reopened = new AuthorityDb(filename);
      expect(() => new ControlEffectAttempts(reopened!).prepareTask(commands[2]!, () => f.now))
        .toThrow("TASK_EXECUTION_ALREADY_BOUND");
      expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM control_effect_attempts").get()).toEqual({ n: 1 });
    } finally {
      await Promise.all(workers.map(async child => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }));
      if (f.db.db.open) f.db.close();
      reopened?.close();
    }
  }, 20_000);
});
