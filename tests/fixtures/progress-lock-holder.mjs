/* global Buffer, process */
import { readSync } from "node:fs";

const entry = process.env.PROGRESS_MODULE_URL;
if (!entry) throw new Error("PROGRESS_MODULE_URL is required");
const { AuthorityDb } = await import(entry);
const [filename, encoded] = process.argv.slice(2);
const db = new AuthorityDb(filename);
await db.migrate();
db.progressTestHook = point => {
  if (point !== "after_outbox_insert_before_commit") return;
  process.stdout.write("READY\n");
  const byte = Buffer.alloc(1); let line = "";
  while (!line.endsWith("\n")) { if (readSync(0, byte, 0, 1, null) === 0) throw new Error("release stream closed"); line += byte.toString("utf8"); }
  if (line !== "RELEASE\n") throw new Error("unexpected release");
};
try { db.stageProgressBatch(JSON.parse(encoded)); db.close(); process.exitCode = 0; }
catch (error) { db.close(); process.stderr.write(`${error?.code ?? "PROGRESS_STORAGE_FAILED"}\n`); process.exitCode = 2; }
