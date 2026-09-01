/* global process */
import { createInterface } from "node:readline";
import { once } from "node:events";
import { AuthorityDb } from "../../dist/src/db.js";
import { MemoryLifecycleBarriers } from "../../dist/src/memory-lifecycle-barriers.js";

const [database, barrier, mode] = process.argv.slice(2);
if (database === undefined || barrier === undefined || (mode !== "hold" && mode !== "recover")) {
  process.exitCode = 2;
} else {
  const input = createInterface({ input: process.stdin });
  const [command] = await once(input, "line");
  if (command !== "GO") {
    input.close();
    process.exitCode = 2;
  } else {
    const authority = new AuthorityDb(database);
    const barriers = new MemoryLifecycleBarriers(authority, {
      async reached(event) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
        if (mode === "hold") await new Promise(() => undefined);
      },
    });
    await barriers.reach({ barrier_id: barrier,
      lane_id: `lane:${barrier}`, request_id: `request:${barrier}`,
      tombstone_sequence: 1, now: new Date("2026-08-31T00:00:00.000Z") });
    authority.close();
    input.close();
  }
}
