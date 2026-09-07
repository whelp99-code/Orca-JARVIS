import process from "node:process";
import { AuthorityDb } from "../../dist/src/db.js";
import { ControlPlane } from "../../dist/src/control-plane.js";
import { settleTaskExecution } from "../../dist/src/task-completion.js";

const db = new AuthorityDb(process.argv[2]);
const pause = result => {
  process.send({ state: "paused", result });
  // Parent SIGKILLs at the observed transaction boundary, without cooperative cleanup.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
process.once("message", async ({ command, publication_id, now, mode }) => {
  if (mode === "before_commit") {
    const emit = ControlPlane.prototype.emit;
    ControlPlane.prototype.emit = function (event) {
      const result = emit.call(this, event);
      if (event.event_type === "workflow.task_completed") pause(event.payload);
      return result;
    };
  }
  try {
    const result = await settleTaskExecution({ authority: db, command, publication_id, clock: () => new Date(now) });
    if (mode === "after_commit") pause(result);
    process.send({ state: "completed", result });
  } catch (error) { process.send({ state: "error", code: error.code ?? "fixture-failed" }); }
});
process.on("disconnect", () => { db.close(); process.exit(0); });
process.send({ state: "ready" });
