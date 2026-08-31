import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import {
  assertRootIdentity,
  secureBasename,
  secureRoot,
  syncDirectory,
  type SecureRoot,
} from "./secure-filesystem.js";
import { parseSecondBrainStrictJson } from "./second-brain-strict-json.js";

const MAX_SPOOL_BYTES = 262_144;
const sha256 = (value: Buffer | string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export type MemorySpoolRecord = {
  readonly locator: string;
  readonly digest: string;
};

export class MemoryEffectSpool {
  private root: SecureRoot | undefined;
  constructor(
    private readonly directory: string,
    private readonly authority: AuthorityDb,
  ) {}

  private async secure(): Promise<SecureRoot> {
    this.root ??= await secureRoot(this.directory);
    await assertRootIdentity(this.root);
    return this.root;
  }

  async write(laneId: string, value: unknown): Promise<MemorySpoolRecord> {
    const root = await this.secure();
    const name = secureBasename(`${laneId}.json`);
    const destination = join(root.path, name);
    const payload = Buffer.from(`${canonicalize(value)}\n`, "utf8");
    if (payload.byteLength > MAX_SPOOL_BYTES) throw new JarvisError("MEMORY_SPOOL_OVERSIZE");
    const temporary = join(root.path, `.${name}.${randomUUID()}.tmp`);
    const file = await open(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(payload);
      await file.sync();
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
        || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
        throw new JarvisError("MEMORY_SPOOL_UNSAFE");
      }
      await assertRootIdentity(root);
      await rename(temporary, destination);
      await syncDirectory(root.path);
      return { locator: name, digest: sha256(payload) };
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    } finally {
      await file.close();
    }
  }

  async rename(locator: string, requestId: string): Promise<string> {
    const root = await this.secure();
    const source = join(root.path, secureBasename(locator));
    const destinationName = secureBasename(`${requestId}.json`);
    await rename(source, join(root.path, destinationName));
    await syncDirectory(root.path);
    return destinationName;
  }

  async read(locator: string, expectedDigest: string): Promise<unknown> {
    const root = await this.secure();
    const path = join(root.path, secureBasename(locator));
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_SPOOL_BYTES
        || (metadata.mode & 0o777) !== 0o600
        || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
        throw new JarvisError("MEMORY_SPOOL_UNSAFE");
      }
      const payload = await file.readFile();
      if (sha256(payload) !== expectedDigest) throw new JarvisError("MEMORY_SPOOL_DIGEST_MISMATCH");
      const text = payload.toString("utf8").trimEnd();
      const parsed = parseSecondBrainStrictJson(text);
      if (parsed === undefined || canonicalize(parsed) !== text) {
        throw new JarvisError("MEMORY_SPOOL_INVALID");
      }
      return parsed;
    } finally {
      await file.close();
    }
  }

  async remove(
    laneId: string,
    locator: string,
    spoolDigest: string,
    disposition: "accepted" | "status_reconciled" | "expired" | "terminal_failure",
    now: Date,
  ): Promise<string> {
    const root = await this.secure();
    await rm(join(root.path, secureBasename(locator)), { force: true });
    await syncDirectory(root.path);
    const body = {
      lane_id: laneId,
      spool_digest: spoolDigest,
      disposition,
      removed: 1,
      parent_fsynced: 1,
      plaintext_matches: 0,
      removed_at: now.toISOString(),
    };
    const receiptDigest = sha256(canonicalize(body));
    const cleanupId = `memspool-clean:v1:${receiptDigest.slice(7)}`;
    this.authority.db.prepare(
      `INSERT OR IGNORE INTO memory_spool_cleanup_receipts(
        cleanup_id,lane_id,spool_digest,disposition,removed,parent_fsynced,plaintext_matches,
        removed_at,receipt_digest,created_at
       ) VALUES(?,?,?,?,1,1,0,?,?,?)`,
    ).run(cleanupId, laneId, spoolDigest, disposition, body.removed_at,
      receiptDigest, body.removed_at);
    return receiptDigest;
  }

  async matches(needle: Buffer): Promise<number> {
    const root = await this.secure();
    const locator = this.authority.db.prepare(
      `SELECT spool_locator FROM memory_effect_preparations
       WHERE state IN ('staged','approved') ORDER BY lane_id`,
    ).all() as Array<{ readonly spool_locator: string }>;
    let count = 0;
    for (const row of locator) {
      const path = join(root.path, secureBasename(basename(row.spool_locator)));
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
      if (file === undefined) continue;
      try {
        const bytes = await file.readFile();
        count += bytes.toString("binary").split(needle.toString("binary")).length - 1;
      } finally {
        await file.close();
      }
    }
    return count;
  }
}
