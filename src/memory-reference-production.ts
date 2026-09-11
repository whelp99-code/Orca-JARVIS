import { constants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { JarvisError, type AuthorityDb } from "./db.js";
import { createMemoryMembership } from "./memory-membership.js";
import { MemoryReferenceReader } from "./memory-reference-reader.js";
import { createSecondBrainReadAdapter } from "./second-brain-adapter.js";
import { createSecondBrainTransport } from "./second-brain-transport.js";
import { createProductionMemoryReadFence } from "./memory-read-fence-production.js";
import type { MemoryOutboxProductionOptions } from "./memory-outbox-production.js";
import type { SecondBrainAdapterOptions } from "./second-brain-adapter-types.js";
import { AssembledModelSession } from "./assembled-model-session.js";
import { RecordingModelTransport, type ModelTransport } from "./context-model-transport.js";

export type MemoryReferenceProductionOptions = Pick<MemoryOutboxProductionOptions,
  "transport" | "transport_options" | "clock" | "read_fence" | "read_fence_config"> & {
  readonly status_fence?: SecondBrainAdapterOptions["read_fence"];
  readonly projection_key?: Buffer;
  readonly model_transport?: ModelTransport;
};

/** Read the existing private projection key. Never generate a replacement on read. */
export function readMemoryReferenceProjectionKey(path: string): Buffer {
  let fd: number | undefined;
  const bytes = Buffer.alloc(33);
  try { try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size !== 32 || (before.mode & 0o077) !== 0
      || (process.getuid !== undefined && before.uid !== process.getuid())) throw new Error();
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (count === 0) break;
      size += count;
    }
    const after = fstatSync(fd);
    if (size !== 32 || after.size !== 32 || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error();
    return Buffer.from(bytes.subarray(0, 32));
  } finally { bytes.fill(0); if (fd !== undefined) closeSync(fd); }
  } catch { throw new JarvisError("MEMORY_REFERENCE_KEY_UNAVAILABLE"); }
}

export function createProductionMemoryReference(authority: AuthorityDb, options: MemoryReferenceProductionOptions = {}) {
  const key = options.projection_key ?? readMemoryReferenceProjectionKey(join(dirname(authority.filename), "memory-projection.key"));
  const membership = createMemoryMembership(key);
  const clock = options.clock ?? (() => new Date());
  const readFence = options.read_fence ?? createProductionMemoryReadFence(authority, options.read_fence_config);
  const statusFence = options.status_fence ?? createProductionMemoryReadFence(authority, options.read_fence_config, "memory_status");
  const transport = options.transport ?? createSecondBrainTransport({
    launcherPath: process.env["JARVIS_SECOND_BRAIN_LAUNCHER"],
    configPath: process.env["JARVIS_SECOND_BRAIN_CONFIG"],
    ...options.transport_options,
  });
  const adapter = createSecondBrainReadAdapter({ transport, clock, contract_profile: "schema4", read_fence: readFence,
    budgets: { max_hits: 32, max_excerpt_bytes: 4096, max_total_bytes: 65536, max_page_bytes: 262144 },
    max_age_ms: 7 * 86400000, expiry_ms: 30 * 86400000 });
  const reader = new MemoryReferenceReader({ authority, adapter, membership, clock,
    generation_status: () => transport.call("sb_generation_status", { read_fence: statusFence?.(clock()) ?? null }),
    assert_authorized: at => { readFence?.(at); statusFence?.(at); } });
  const modelSession = new AssembledModelSession(authority, options.model_transport ?? new RecordingModelTransport());
  let closing: Promise<void> | undefined;
  return { reader, deliverAssembled: modelSession.deliver.bind(modelSession), close: (): Promise<void> => {
    if (options.transport !== undefined) return Promise.resolve();
    return closing ??= transport.close();
  } };
}
