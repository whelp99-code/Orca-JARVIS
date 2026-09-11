/* global process */
// A second process that does to the authority database exactly what a real one does: opens it and
// keeps it open. Nothing here is timed - the parent reads a line to know the connection exists and
// writes a line to make it go away - so the swap under test always meets a holder that is really
// there, or really gone.
import { writeSync } from "node:fs";
import { AuthorityDb } from "../../dist/src/db.js";
import { publishSwapBarrier } from "../../dist/src/authority-database-swap-barrier.js";

const [databasePath, mode] = process.argv.slice(2);

if (mode === "abandon") {
  // Takes the barrier and dies holding it, which is the one way a barrier can outlive its owner.
  publishSwapBarrier(databasePath, "local_retention", new Date());
  writeSync(1, "published\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

if (mode === "open") {
  // Tries to join the database the way any cooperating process would. While a swap holds the
  // barrier this must be refused rather than admitted into a file about to be renamed away.
  try {
    const joined = new AuthorityDb(databasePath);
    writeSync(1, "opened\n");
    joined.close();
  } catch (error) {
    writeSync(1, `refused ${JSON.stringify({ code: error?.code ?? error?.message ?? null })}\n`);
  }
  process.exit(0);
}

const authority = new AuthorityDb(databasePath);
writeSync(1, "holding\n");
process.stdin.on("data", () => {
  authority.close();
  process.exit(0);
});
