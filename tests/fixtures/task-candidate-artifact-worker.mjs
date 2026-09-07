import process from "node:process";
import { Buffer } from "node:buffer";
import { AuthorityDb } from "../../dist/src/db.js";
import { TaskCandidateArtifacts } from "../../dist/src/task-candidate-artifacts.js";

const db = new AuthorityDb(process.argv[2]);
const store = new TaskCandidateArtifacts(db);
process.once("message", ({ command, input, now, mode }) => {
  try {
    const save = () => store.save(command, { ...input,
      files: input.files.map(file => ({ path: file.path, content: Buffer.from(file.base64, "base64") })) }, () => new Date(now));
    if (mode === "before_commit") {
      db.db.transaction(() => {
        save();
        process.send({ state: "uncommitted" });
        // Parent kills this isolated test process after observing the open transaction.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }).immediate();
    } else {
      const artifact = save();
      process.send({ state: "saved", artifact_id: artifact.artifact_id, candidate_digest: artifact.candidate_digest });
    }
  } catch (error) { process.send({ state: "rejected", code: error.code ?? "worker-error" }); }
});
process.on("disconnect", () => { db.close(); process.exit(0); });
process.send({ state: "ready", pid: process.pid });
