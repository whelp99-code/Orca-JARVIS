/* global process */
import { once } from "node:events";
import { createInterface } from "node:readline";
import { AuthorityDb } from "../../dist/src/db.js";

const [database, lane, worker] = process.argv.slice(2);
if (database === undefined || lane === undefined || worker === undefined) {
  process.exitCode = 2;
} else {
  const input = createInterface({ input: process.stdin });
  const [arm] = await once(input, "line");
  if (arm !== "ARM") {
    input.close();
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify({ kind: "ready", pid: process.pid })}\n`);
    const [go] = await once(input, "line");
    if (go !== "GO") {
      input.close();
      process.exitCode = 2;
    } else {
      const authority = new AuthorityDb(database);
      authority.db.pragma("busy_timeout=10000");
      const inserted = authority.db.transaction(() => authority.db.prepare(
        "INSERT OR IGNORE INTO task30_harness_frames(lane,worker,process_id) VALUES(?,?,?)",
      ).run(lane, worker, process.pid)).immediate();
      if (inserted.changes === 0) {
        process.stdout.write(`${JSON.stringify({ kind: "contended", lane, worker, pid: process.pid })}\n`);
        authority.close();
        input.close();
      } else {
        process.stdout.write(`${JSON.stringify({ kind: "frame", lane, worker, pid: process.pid })}\n`);
        const [settle] = await once(input, "line");
        const prefix = "SETTLE ";
        if (typeof settle !== "string" || !settle.startsWith(prefix)) {
          authority.close();
          input.close();
          process.exitCode = 2;
        } else {
          const effectId = settle.slice(prefix.length);
          authority.db.transaction(() => authority.db.prepare(
            "INSERT INTO task30_harness_settlements(lane,effect_id,worker) VALUES(?,?,?)",
          ).run(lane, effectId, worker)).immediate();
          process.stdout.write(`${JSON.stringify({ kind: "settled", lane, worker,
            effect_id: effectId, pid: process.pid })}\n`);
          authority.close();
          input.close();
        }
      }
    }
  }
}
