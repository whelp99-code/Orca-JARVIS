import process from "node:process";
import { AuthorityDb } from "../../dist/src/db.js";
import { TaskCandidateCertifications } from "../../dist/src/task-candidate-certifications.js";

const db = new AuthorityDb(process.argv[2]);
process.once("message", ({ command, verification_id, now }) => {
  try {
    const value = new TaskCandidateCertifications(db).begin(command, verification_id, () => new Date(now));
    process.send({ state: "running", invocation_id: value.invocation_id, clock_id: value.request.clock_id,
      deadline_uptime_ms: value.request.deadline_uptime_ms, remaining_ms: value.remaining_ms });
  } catch (error) { process.send({ state: "rejected", code: error.code ?? "worker-error" }); }
});
process.on("disconnect", () => { db.close(); process.exit(0); });
process.send({ state: "ready", pid: process.pid });
