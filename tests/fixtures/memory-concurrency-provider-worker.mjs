/* global process */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { AuthorityDb } from "../../dist/src/db.js";

const [database, provider] = process.argv.slice(2);
if (database === undefined || provider === undefined) {
  process.exitCode = 2;
} else {
  const input = createInterface({ input: process.stdin });
  const [arm] = await once(input, "line");
  if (arm !== "ARM") {
    input.close();
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify({ kind: "ready", pid: process.pid })}\n`);
    const authority = new AuthorityDb(database);
    authority.db.pragma("busy_timeout=10000");
    for await (const command of input) {
      if (command === "STOP") {
        process.stdout.write(`${JSON.stringify({ kind: "stopped", pid: process.pid })}\n`);
        break;
      }
      const prefix = "PROCESS ";
      if (!command.startsWith(prefix)) {
        process.exitCode = 2;
        break;
      }
      const lane = command.slice(prefix.length);
      const effectId = `effect:${createHash("sha256").update(lane).digest("hex")}`;
      const changed = authority.db.transaction(() => {
        const claim = authority.db.prepare(
          "INSERT OR IGNORE INTO task30_harness_claims(lane,provider,process_id) VALUES(?,?,?)",
        ).run(lane, provider, process.pid);
        if (claim.changes === 1) authority.db.prepare(
          "INSERT INTO task30_harness_effects(lane,effect_id,provider) VALUES(?,?,?)",
        ).run(lane, effectId, provider);
        return claim.changes;
      }).immediate();
      process.stdout.write(`${JSON.stringify({ kind: changed === 1 ? "effect" : "contended",
        lane, effect_id: effectId, pid: process.pid })}\n`);
    }
    authority.close();
    input.close();
  }
}
