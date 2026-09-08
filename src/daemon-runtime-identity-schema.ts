import { z } from "zod";
import type { RuntimeIdentityReport } from "./runtime-identity-contracts.js";
import type { RuntimeProcessIncarnation } from "./runtime-process-identity.js";

const timestamp = z.string().max(27).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable();
const count = z.number().int().min(0).max(16_384).nullable();
const snapshotSchema = z.object({
  schema_version: z.literal(1),
  process: z.object({ pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), started_at: timestamp,
    node: z.string().max(64).regex(/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/), modules: z.string().regex(/^\d{1,6}$/),
    platform: z.string().regex(/^[a-z0-9_]{1,32}$/), arch: z.string().regex(/^[a-z0-9_]{1,32}$/) }).strict(),
  build: z.object({ status: z.enum(["matched", "mismatch", "missing", "invalid", "unreadable"]), checked_at: timestamp,
    source_head: z.string().regex(/^[0-9a-f]{40}$/).nullable(), source_dirty: z.boolean().nullable(),
    input_digest: hash, artifact_digest: hash, observed_artifact_digest: hash, artifact_files: count,
    migration_digest: hash, migration_count: count, toolchain_status: z.enum(["matched", "mismatch", "unknown"]) }).strict(),
  incarnation: z.object({ boot_id: z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
    pid_namespace: z.string().max(64).regex(/^pid:\[\d+\]$/), start_token: z.string().max(32).regex(/^\d+$/) }).strict().nullable(),
}).strict();
export type DaemonRuntimeSnapshot = { readonly schema_version: 1; readonly process: RuntimeIdentityReport["process"];
  readonly build: RuntimeIdentityReport["build"]; readonly incarnation: RuntimeProcessIncarnation | null };
export function parseDaemonRuntimeSnapshot(value: unknown): DaemonRuntimeSnapshot { return snapshotSchema.parse(value); }
export function validRuntimeTimestamp(value: unknown): value is string { return timestamp.safeParse(value).success; }
