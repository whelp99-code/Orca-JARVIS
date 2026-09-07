import process from "node:process";
import { AuthorityDb } from "../../dist/src/db.js";
import { TaskPublicationJournal } from "../../dist/src/task-publication-journal.js";
import { publishTaskGitCandidate } from "../../dist/src/task-git-publication.js";

const db = new AuthorityDb(process.argv[2]);
process.once("message", async ({ command, verification_id, now, mode }) => {
  const prepared = TaskPublicationJournal.prototype.prepared;
  const published = TaskPublicationJournal.prototype.published;
  const pause = commit => {
    process.send({ state: "paused", commit });
    // The parent observes this exact durable boundary and kills this fixture process.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  if (mode === "before_ref") TaskPublicationJournal.prototype.prepared = function (...args) {
    const result = prepared.apply(this, args); pause(result.row.commit_oid); return result;
  };
  else TaskPublicationJournal.prototype.published = function (...args) {
    pause(args[2]); return published.apply(this, args);
  };
  try { await publishTaskGitCandidate({ authority: db, command, verification_id, clock: () => new Date(now) }); }
  catch (error) { process.send({ state: "error", code: error.code ?? "fixture-failed" }); }
});
process.on("disconnect", () => { db.close(); process.exit(0); });
process.send({ state: "ready" });
