import { createPrivateKey } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { AuthorityDb, JarvisError } from "./db.js";
import { verifyStoredTaskCandidate } from "./task-independent-verifier.js";
import type { ClaimedControlCommand } from "./control-plane.js";

async function privateVerifierKey(path: string) {
  if (!isAbsolute(path) || await realpath(path) !== path) throw new JarvisError("TASK_CERTIFICATION_KEY_INVALID");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.nlink !== 1
      || before.size < 1 || before.size > 16384) throw new JarvisError("TASK_CERTIFICATION_KEY_INVALID");
    const bytes = Buffer.alloc(before.size + 1);
    try {
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      const after = await file.stat();
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || await realpath(`/proc/${process.pid}/fd/${file.fd}`) !== path) throw new JarvisError("TASK_CERTIFICATION_KEY_INVALID");
      return createPrivateKey(bytes.subarray(0, length));
    } finally { bytes.fill(0); }
  } finally { await file.close(); }
}

async function main() {
  let db: AuthorityDb | undefined;
  const inputTimer = setTimeout(() => process.exit(1), 10000);
  try {
    const [database, keyPath] = process.argv.slice(2);
    if (process.argv.length !== 4 || !database || !keyPath || !isAbsolute(database)) throw new JarvisError("TASK_VERIFIER_INPUT_INVALID");
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk); length += bytes.length;
      if (length > 4 * 1024 * 1024) throw new JarvisError("TASK_VERIFIER_INPUT_INVALID");
      chunks.push(bytes);
    }
    clearTimeout(inputTimer);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { command: ClaimedControlCommand; verification_id: string };
    if (!input || Object.keys(input).sort().join(",") !== "command,verification_id" || typeof input.verification_id !== "string") {
      throw new JarvisError("TASK_VERIFIER_INPUT_INVALID");
    }
    const key = await privateVerifierKey(keyPath);
    db = new AuthorityDb(database);
    const proof = await verifyStoredTaskCandidate(db, input.command, input.verification_id, key);
    process.stdout.write(JSON.stringify(proof) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error instanceof JarvisError ? error.code : "TASK_VERIFIER_FAILED" }) + "\n");
    process.exitCode = 1;
  } finally { clearTimeout(inputTimer); db?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
