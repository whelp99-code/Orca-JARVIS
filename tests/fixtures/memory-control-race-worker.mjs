import process from "node:process";
import { createInterface } from "node:readline";
import { AuthorityDb, JarvisError } from "../../dist/src/db.js";
import { ControlPlane } from "../../dist/src/control-plane.js";

const [database, requestId, at, worker] = process.argv.slice(2);
const lines = createInterface({ input: process.stdin });
let db;
lines.once("line", () => {
  db = new AuthorityDb(database);
  db.db.pragma("busy_timeout=0");
  process.stdout.write("READY\n");
  lines.once("line", () => {
    try {
      const claimed = new ControlPlane(db).claim(requestId, worker, new Date(at));
      process.stdout.write(`${JSON.stringify({ kind: "claimed", fence: claimed.fence })}\n`);
    } catch (error) {
      if (error instanceof JarvisError) {
        process.stdout.write(`${JSON.stringify({ kind: "no_effect", code: error.code })}\n`);
      } else if (error instanceof Error && "code" in error) {
        process.stdout.write(`${JSON.stringify({ kind: "raw_error", code: error.code })}\n`);
      } else throw error;
    } finally {
      db.close(); lines.close();
    }
  });
});
