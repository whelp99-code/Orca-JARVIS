import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { assertRootIdentity, secureBasename, secureRoot, syncDirectory,
  type SecureRoot } from "./secure-filesystem.js";

export type MemoryCorrectionPublication = { readonly locator: string; readonly digest: string;
  readonly content_bytes: number; readonly created: boolean };
type PublicationInput = { readonly control_request_id: string; readonly intent_digest: string;
  readonly semantic_digest: string; readonly target_manifest_digest: string; readonly scope_digest: string;
  readonly expected_prior_digest: string; readonly content_digest: string; readonly replacement: string;
  readonly created_at: string; readonly expires_at: string };

export class MemoryCorrectionSpool {
  private secureRoot: SecureRoot | undefined;
  constructor(private readonly root: string) {}

  async publish(input: PublicationInput): Promise<MemoryCorrectionPublication> {
    const root = await this.secure();
    const contentBytes = Buffer.byteLength(input.replacement, "utf8");
    const core = { schema_version: 1, ...input, content_bytes: contentBytes };
    const spoolDigest = `sha256:${createHash("sha256").update("orca-jarvis/memory-correction-spool/v1\0")
      .update(canonicalize(core)).digest("hex")}`;
    const payload = Buffer.from(`${canonicalize({ ...core, spool_digest: spoolDigest })}\n`, "utf8");
    const name = secureBasename(`${input.control_request_id}.json`);
    const destination = join(root.path, name);
    const temporary = join(root.path, `.${name}.${randomUUID()}.tmp`);
    const handle = await open(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(payload); await handle.sync();
      assertSafeFile(await handle.stat(), 1);
      await assertRootIdentity(root);
      try {
        await link(temporary, destination);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const existing = await readSafeFile(destination);
        if (!existing.equals(payload)) throw new JarvisError("MEMORY_CORRECTION_SPOOL_REPLAY_CONFLICT");
        return { locator: destination, digest: spoolDigest, content_bytes: contentBytes, created: false };
      }
      await rm(temporary); await syncDirectory(root.path);
      const published = await readSafeFile(destination);
      if (!published.equals(payload)) throw new JarvisError("MEMORY_EFFECT_SPOOL_UNSAFE");
      return { locator: destination, digest: spoolDigest, content_bytes: contentBytes, created: true };
    } finally {
      await handle.close(); await rm(temporary, { force: true });
    }
  }

  async compensate(publication: MemoryCorrectionPublication): Promise<void> {
    if (!publication.created) return;
    const root = await this.secure();
    const payload = await readSafeFile(publication.locator);
    if (!payload.includes(Buffer.from(publication.digest, "utf8"))) {
      throw new JarvisError("MEMORY_EFFECT_SPOOL_UNSAFE");
    }
    await rm(publication.locator); await syncDirectory(root.path);
  }

  private async secure(): Promise<SecureRoot> {
    this.secureRoot ??= await secureRoot(this.root);
    await assertRootIdentity(this.secureRoot);
    return this.secureRoot;
  }
}

async function readSafeFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat(); assertSafeFile(metadata, 1);
    return await handle.readFile();
  } finally { await handle.close(); }
}
function assertSafeFile(metadata: Stats, links: number): void {
  const owner = typeof process.getuid !== "function" || metadata.uid === process.getuid();
  if (!metadata.isFile() || metadata.nlink !== links || (metadata.mode & 0o777) !== 0o600 || !owner) {
    throw new JarvisError("MEMORY_EFFECT_SPOOL_UNSAFE");
  }
}
function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
}
