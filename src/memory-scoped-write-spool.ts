import { join } from "node:path";
import { inspectPrivateSpoolRoot, recoverPrivateSpoolPublication, readPrivateSpoolFile, writePrivateSpoolFile,
  type PrivateSpoolRoot } from "./memory-private-spool-files.js";
import { parseMemoryScopedWriteRequestJson } from "./memory-scoped-write-codec.js";
import { JarvisError } from "./db.js";

/** Immutable request material, not a queue or authority redemption. The operator
 * supplies an existing private root. No automatic CLI/provider wiring. */
export class MemoryScopedWriteSpool {
  private readonly root: PrivateSpoolRoot;
  constructor(root: string, private readonly provider: string) {
    this.root = inspectPrivateSpoolRoot(root);
  }
  private path(key: string): string {
    if (!/^memidem:scoped:v4:[0-9a-f]{64}$/.test(key) || key.length !== 82) {
      throw new JarvisError("SCOPED_WRITE_SPOOL_KEY_INVALID");
    }
    return join(this.root.path, `${key.slice(-64)}.v4.json`);
  }
  read(key: string, now: Date) {
    const bytes = readPrivateSpoolFile(this.root, this.path(key), 32768);
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const request = parseMemoryScopedWriteRequestJson(raw, this.provider, now);
    if (request.idempotency_key !== key) throw new JarvisError("SCOPED_WRITE_SPOOL_IDENTITY_INVALID");
    return request;
  }
  publish(raw: string, now: Date) {
    const request = parseMemoryScopedWriteRequestJson(raw, this.provider, now);
    const path = this.path(request.idempotency_key);
    const created = writePrivateSpoolFile(this.root, path, Buffer.from(raw), "scoped-write");
    recoverPrivateSpoolPublication(this.root, path, Buffer.from(raw), "scoped-write");
    const bytes = readPrivateSpoolFile(this.root, path, 32768);
    if (!bytes.equals(Buffer.from(raw))) throw new JarvisError("SCOPED_WRITE_SPOOL_CONFLICT");
    return Object.freeze({ path, created, request_id: request.request_id, request_digest: request.request_digest,
      idempotency_key: request.idempotency_key });
  }
}
