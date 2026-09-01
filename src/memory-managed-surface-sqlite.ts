import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import {
  countForbiddenContentMatches,
  type ForbiddenContentIdentity,
} from "./memory-forbidden-content.js";
import type {
  ManagedSurfaceDefinition,
  MemoryManagedSurfaceEntry,
} from "./memory-managed-surface-types.js";

export function scanSqliteSurface(input: {
  readonly authority: AuthorityDb;
  readonly definition: ManagedSurfaceDefinition;
  readonly prefixes: readonly string[];
  readonly identities: readonly ForbiddenContentIdentity[];
}): MemoryManagedSurfaceEntry {
  const names = input.authority.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().flatMap(value => {
    const name = value !== null && typeof value === "object" ? Reflect.get(value, "name") : undefined;
    return typeof name === "string" && input.prefixes.some(prefix => name.startsWith(prefix))
      ? [name] : [];
  });
  let rowCount = 0;
  let matchCount = 0;
  for (const name of names) {
    const rows = input.authority.db.prepare(`SELECT * FROM ${quote(name)}`).all();
    rowCount += rows.length;
    for (const row of rows) matchCount += rowMatches(row, input.identities);
  }
  if (input.definition.surface_id === "authority_db_main_wal_shm_journal_freelist") {
    return authorityStorageEntry(input, { names, row_count: rowCount,
      logical_matches: matchCount });
  }
  const manifestDigest = digest({ tables: names, row_count: rowCount,
    match_count: matchCount });
  return { ...input.definition, applicable: true, readable: true,
    manifest_digest: manifestDigest, file_count: 0, row_count: rowCount,
    object_count: names.length, fd_count: 0, match_count: matchCount,
    error_count: 0, omission_count: 0, scan_digest: manifestDigest };
}

function authorityStorageEntry(
  input: {
    readonly authority: AuthorityDb;
    readonly definition: ManagedSurfaceDefinition;
    readonly identities: readonly ForbiddenContentIdentity[];
  },
  observed: {
    readonly names: readonly string[];
    readonly row_count: number;
    readonly logical_matches: number;
  },
): MemoryManagedSurfaceEntry {
  const files = [input.authority.filename, `${input.authority.filename}-wal`,
    `${input.authority.filename}-shm`, `${input.authority.filename}-journal`]
    .filter(path => existsSync(path));
  const observations: Array<{ readonly digest: string; readonly bytes: number }> = [];
  let errors = 0;
  let physicalMatches = 0;
  for (const path of files) {
    try {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        errors += 1;
        continue;
      }
      const bytes = readFileSync(path);
      observations.push({ digest: digest(bytes), bytes: bytes.byteLength });
      physicalMatches += countForbiddenContentMatches(bytes, input.identities);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      errors += 1;
    }
  }
  const freePages = Number(input.authority.db.pragma("freelist_count", { simple: true }));
  if (!Number.isSafeInteger(freePages) || freePages < 0) {
    throw new JarvisError("MEMORY_SURFACE_SCAN_FAILED");
  }
  const manifestDigest = digest({ tables: observed.names, row_count: observed.row_count,
    files: observations, free_pages: freePages, logical_matches: observed.logical_matches,
    physical_matches: physicalMatches, errors });
  return { ...input.definition, applicable: true, readable: errors === 0,
    manifest_digest: manifestDigest, file_count: files.length, row_count: observed.row_count,
    object_count: observed.names.length + freePages, fd_count: 0,
    match_count: observed.logical_matches + physicalMatches, error_count: errors,
    omission_count: files.length === 0 ? 1 : 0, scan_digest: manifestDigest };
}

function rowMatches(value: unknown, identities: readonly ForbiddenContentIdentity[]): number {
  if (value === null || typeof value !== "object") return 0;
  let matches = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") continue;
    const field = Reflect.get(value, key);
    if (typeof field === "string") {
      matches += countForbiddenContentMatches(Buffer.from(field), identities);
    } else if (Buffer.isBuffer(field)) {
      matches += countForbiddenContentMatches(field, identities);
    }
  }
  return matches;
}

function digest(value: unknown): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonicalize(value));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
