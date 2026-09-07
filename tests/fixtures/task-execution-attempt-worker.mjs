import process from "node:process";
import { AuthorityDb } from "../../dist/src/db.js";
import { ControlEffectAttempts } from "../../dist/src/control-effect-attempts.js";

const db = new AuthorityDb(process.argv[2]);
const attempts = new ControlEffectAttempts(db);
process.once("message", ({ command, now }) => {
  try {
    attempts.prepareTask(command, () => new Date(now));
    attempts.beginTaskInvocation(command, () => new Date(now));
    process.send({ state: "invoking", pid: process.pid, request_id: command.request_id });
  } catch (error) {
    process.send({ state: "rejected", pid: process.pid, code: error.code ?? "worker-error" });
  }
});
process.on("disconnect", () => { db.close(); process.exit(0); });
process.send({ state: "ready", pid: process.pid });
