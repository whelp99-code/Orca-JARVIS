import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import {
  effectiveUserId,
  ProcessObservationError,
  processStartToken,
  type RegisteredAuthorityProcess,
} from "./authority-database-process.js";
import { JarvisError } from "./db.js";

const RegistryRecordSchema = z.object({
  schema_version: z.literal(1),
  pid: z.number().int().positive(),
  start_token: z.string().regex(/^\d+$/),
  database: z.string().min(1),
  generation: z.number().int().positive(),
  active_leases: z.number().int().nonnegative(),
  state: z.enum(["active", "quiescing"]),
}).strict();

export type AuthorityRegistryRecord = z.infer<typeof RegistryRecordSchema>;

export class AuthorityProcessRegistry {
  private readonly path: string;

  constructor(
    private readonly root: string,
    private readonly database: string,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const startToken = processStartToken(process.pid);
    this.path = join(root, `${process.pid}.${startToken}.json`);
  }

  persist(record: AuthorityRegistryRecord): void {
    if (record.pid !== process.pid || record.database !== this.database
      || record.start_token !== processStartToken(process.pid)) {
      throw new JarvisError("AUTHORITY_REGISTRY_INVALID");
    }
    const parsed = RegistryRecordSchema.safeParse(record);
    if (!parsed.success) throw new JarvisError("AUTHORITY_REGISTRY_INVALID");
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${canonicalize(parsed.data)}\n`, { mode: 0o600, flag: "w" });
    syncPath(temporary);
    renameSync(temporary, this.path);
    syncPath(this.root);
  }

  processes(): readonly RegisteredAuthorityProcess[] {
    const processes: RegisteredAuthorityProcess[] = [];
    for (const name of readdirSync(this.root).sort()) {
      if (name.endsWith(".json.tmp")) continue;
      const match = /^(\d+)\.(\d+)\.json$/.exec(name);
      if (match === null) throw new JarvisError("AUTHORITY_REGISTRY_INVALID");
      const path = join(this.root, name);
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || metadata.uid !== effectiveUserId() || (metadata.mode & 0o077) !== 0) {
        throw new JarvisError("AUTHORITY_REGISTRY_INVALID");
      }
      const parsed = registryRecord(path);
      if (parsed.database !== this.database
        || parsed.pid !== Number(match[1]) || parsed.start_token !== match[2]) {
        throw new JarvisError("AUTHORITY_REGISTRY_INVALID");
      }
      if (currentStartToken(parsed.pid) !== parsed.start_token) {
        rmSync(path, { force: true });
        continue;
      }
      processes.push({ pid: parsed.pid, start_token: parsed.start_token });
    }
    return processes;
  }

  close(): void {
    rmSync(this.path, { force: true });
    rmSync(`${this.path}.tmp`, { force: true });
    syncPath(this.root);
  }
}

function registryRecord(path: string): AuthorityRegistryRecord {
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new JarvisError("AUTHORITY_REGISTRY_INVALID");
    throw error;
  }
  const parsed = RegistryRecordSchema.safeParse(decoded);
  if (!parsed.success) throw new JarvisError("AUTHORITY_REGISTRY_INVALID");
  return parsed.data;
}

function currentStartToken(pid: number): string | undefined {
  if (!existsSync(`/proc/${pid}`)) return undefined;
  try {
    return processStartToken(pid);
  } catch (error) {
    if (error instanceof ProcessObservationError && !existsSync(`/proc/${pid}`)) return undefined;
    throw error;
  }
}

function syncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
