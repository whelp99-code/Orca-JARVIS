import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";

/** Where an operation keeps what it writes. The candidate is what a swap renames into place. */
export type RetentionPaths = {
  readonly directory: string;
  readonly candidate: string;
  readonly snapshot: string;
};

/**
 * Takes exclusive ownership of a directory that holds everything this operation writes.
 *
 * String inequality is not file inequality: `/dir/./authority.sqlite`, a relative spelling and a
 * symlink all name the source. The claim resolves the real parent, refuses the source's own file,
 * and then creates the directory, which fails if anything already holds that name. Everything the
 * operation writes lives inside it, so no file that existed before this call can sit where an
 * artifact goes, and releasing is removing one directory rather than guessing at names beside it.
 */
export function resolveRetentionDirectory(source: AuthorityDb, freshPath: string): string {
  if (typeof freshPath !== "string" || freshPath.trim().length === 0) {
    throw new JarvisError("LOCAL_RETENTION_DESTINATION_INVALID");
  }
  const absolute = resolve(freshPath);
  try {
    const directory = join(realpathSync(dirname(absolute)), basename(absolute));
    // A name already taken - by the source, by a file, by a symlink - is refused before anything
    // is written down. The create below is still what decides ownership; this only keeps a run
    // from announcing a path it cannot have.
    if (directory === realpathSync(source.filename) || existsSync(directory)
      || lstatSync(directory, { throwIfNoEntry: false }) !== undefined) {
      throw new JarvisError("LOCAL_RETENTION_DESTINATION_INVALID");
    }
    return directory;
  } catch {
    throw new JarvisError("LOCAL_RETENTION_DESTINATION_INVALID");
  }
}

/**
 * The name this run builds under before the destination is its own.
 *
 * Derived from the destination and this run's operation id, so recovery can find it from the
 * intent row alone, and unguessable in the way a caller-chosen destination is not: nothing existed
 * at this name before this run generated the id that spells it.
 */
export function stagedClaimPath(directory: string, operationId: string): string {
  return join(dirname(directory),
    `.${basename(directory)}.${operationId.replace(/^retention:/, "")}.staged`);
}

/**
 * Creates everything this operation writes, under a name of its own, and only then takes the
 * destination.
 *
 * The destination used to be created first and its identity recorded a moment later, which left a
 * window: a process that died in between left a directory nobody could prove and an intent holding
 * that path, and because an unproven object is preserved rather than deleted, every later run was
 * refused that destination for good. Building under the staged name closes it. The identity is
 * recorded while the objects are still there, the rename carries the same inode to the
 * destination, and a crash before the rename leaves nothing at the destination at all.
 */
export function claimRetentionOperation(directory: string, staged: string): RetentionPaths {
  try {
    mkdirSync(staged, { mode: 0o700 });
  } catch {
    throw new JarvisError("LOCAL_RETENTION_DESTINATION_INVALID");
  }
  // The candidate file exists from the claim so the operation record can identify it before the
  // build writes through it; the build opens this file rather than creating its own.
  closeSync(openSync(join(staged, "candidate.sqlite"), "wx", 0o600));
  return { directory, candidate: join(directory, "candidate.sqlite"),
    snapshot: join(directory, "snapshot.sqlite") };
}

/** Moves the staged objects onto the destination, which nothing else may hold. */
export function takeRetentionDestination(staged: string, directory: string): void {
  if (existsSync(directory)) throw new JarvisError("LOCAL_RETENTION_DESTINATION_INVALID");
  try {
    renameSync(staged, directory);
  } catch {
    throw new JarvisError("LOCAL_RETENTION_DESTINATION_INVALID");
  }
}

/** Removes the directory this call created, and only that. */
export function releaseRetentionOperation(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}
