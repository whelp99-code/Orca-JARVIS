import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";

export class MemoryCorrectionSpool {
  constructor(private readonly root: string) {}
  async publish(input: { readonly control_request_id: string; readonly intent_digest: string;
    readonly semantic_digest: string; readonly target_manifest_digest: string; readonly scope_digest: string;
    readonly expected_prior_digest: string; readonly content_digest: string; readonly replacement: string;
    readonly created_at: string; readonly expires_at: string }) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await stat(this.root);
    if (!rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0) throw new JarvisError("MEMORY_EFFECT_SPOOL_UNSAFE");
    const contentBytes = Buffer.byteLength(input.replacement, "utf8");
    const core = { schema_version: 1, ...input, content_bytes: contentBytes };
    const spoolDigest = `sha256:${createHash("sha256").update("orca-jarvis/memory-correction-spool/v1\0")
      .update(canonicalize(core)).digest("hex")}`;
    const payload = `${canonicalize({ ...core, spool_digest: spoolDigest })}\n`;
    const final = join(this.root, `${input.control_request_id}.json`);
    const temporary = `${final}.${process.pid}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(payload, "utf8"); await handle.sync(); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
    finally { await handle.close(); }
    await rename(temporary, final);
    return { locator: final, digest: spoolDigest, content_bytes: contentBytes };
  }
}
