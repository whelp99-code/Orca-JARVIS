import { z } from "zod";
import { BUILD_MAX_BYTES, BUILD_MAX_FILES, BUILD_ROOTS, fileVectorHash, migrationVectorHash } from "./backend-build-files.js";

const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const count = z.number().int().min(0).max(BUILD_MAX_FILES);
const bytes = z.number().int().min(0).max(BUILD_MAX_BYTES);
const file = z.object({ path: z.string().min(1).max(2048), bytes, mode: z.number().int().min(0).max(0o777), sha256: hash }).strict();
const migration = z.object({ id: z.string().min(1).max(2048), checksum: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const manifest = z.object({
  schema_version: z.literal(1), kind: z.literal("jarvis-backend-build"),
  source: z.object({ head: z.string().regex(/^[0-9a-f]{40}$/).nullable(), dirty: z.boolean().nullable(),
    input_digest: hash, input_file_count: count,
    toolchain: z.object({ node: z.string().regex(/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
      modules: z.string().regex(/^\d{1,6}$/), platform: z.string().regex(/^[a-z0-9_]{1,32}$/),
      arch: z.string().regex(/^[a-z0-9_]{1,32}$/), typescript: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
    }).strict(),
  }).strict(),
  artifact: z.object({ entries: z.array(file).max(BUILD_MAX_FILES), file_count: count,
    total_bytes: bytes, digest: hash }).strict(),
  migrations: z.array(migration).max(BUILD_MAX_FILES), migration_digest: hash,
}).strict();

export type BackendBuildRecord = z.infer<typeof manifest>;
export function parseBackendBuildRecord(value: unknown): BackendBuildRecord {
  const record = manifest.parse(value);
  const entries = record.artifact.entries;
  for (const [index, entry] of entries.entries()) {
    const parts = entry.path.split("/");
    if (!BUILD_ROOTS.some(root => parts[0] === root) || parts.length < 2
      || parts.some(part => part === "" || part === "." || part === ".." || part.includes("\\")
        || [...part].some(char => char.charCodeAt(0) < 32))
      || (index > 0 && Buffer.compare(Buffer.from(entries[index - 1]!.path), Buffer.from(entry.path)) >= 0)) {
      throw new Error("BUILD_RECORD_INVALID");
    }
  }
  const migrations = entries.filter(entry => entry.path.startsWith("migrations/") && entry.path.endsWith(".sql"))
    .map(entry => ({ id: entry.path.slice("migrations/".length), checksum: entry.sha256.slice("sha256:".length) }));
  if (record.artifact.file_count !== entries.length
    || record.artifact.total_bytes !== entries.reduce((sum, entry) => sum + entry.bytes, 0)
    || record.artifact.digest !== fileVectorHash(entries)
    || JSON.stringify(record.migrations) !== JSON.stringify(migrations)
    || record.migration_digest !== migrationVectorHash(migrations)) throw new Error("BUILD_RECORD_INVALID");
  return record;
}
