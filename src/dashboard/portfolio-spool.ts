import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { JarvisError } from "../db.js";
import { PORTFOLIO_MAX_BYTES } from "./portfolio-contracts.js";

/**
 * The handoff between a collector that may not open the authority database and an ingest that must.
 *
 * Before this split the collector piped its signed envelope straight into `portfolio ingest`, so
 * the one process that reads the local host - and therefore has to run as the interactive user who
 * owns the Orca GUI session - was also the process that opened `jarvis.sqlite`. After the authority
 * moved to a dedicated service account that is exactly the shape the retention lane refuses
 * (`owner_outside_this_user`), and the collector had to be retired (cutover gap G4).
 *
 * A spool file is the collector's existing output byte-for-byte: the same self-describing, HMAC
 * signed envelope, under the same key identity. Nothing here parses or trusts it; the authority
 * still verifies every envelope on ingest. The directory is the whole protocol:
 *
 *   <spool>/<sha256>.portfolio.json            a written, unconsumed envelope
 *   <spool>/processed/<sha256>.portfolio.json  the digest ledger: consumed, never consumed again
 *   <spool>/refused/<name>                     quarantined, with the refusal reported by ingest
 */
export const PORTFOLIO_SPOOL_SUFFIX = ".portfolio.json";
export const PORTFOLIO_SPOOL_PROCESSED = "processed";
export const PORTFOLIO_SPOOL_REFUSED = "refused";
/** One ingest consumes a bounded batch, so a spool an operator has let grow cannot stall a lane. */
export const PORTFOLIO_SPOOL_MAX_FILES = 256;
const SPOOL_DIRECTORY_MODE = 0o750;
const SPOOL_FILE_MODE = 0o640;

export function portfolioSpoolDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function portfolioSpoolName(digest: string): string {
  return `${digest}${PORTFOLIO_SPOOL_SUFFIX}`;
}

/**
 * Writes one envelope into the spool. The file is created under a temporary name and renamed into
 * place, so an ingest running concurrently never reads a partial envelope. The name is the
 * envelope's own digest, which makes re-collecting an identical envelope idempotent on disk too.
 */
export async function writePortfolioSpoolFile(
  directory: string,
  bytes: Buffer,
): Promise<{ readonly path: string; readonly digest: string }> {
  if (bytes.byteLength < 1 || bytes.byteLength > PORTFOLIO_MAX_BYTES) {
    throw new JarvisError("PORTFOLIO_INPUT_INVALID");
  }
  await mkdir(directory, { recursive: true, mode: SPOOL_DIRECTORY_MODE });
  const digest = portfolioSpoolDigest(bytes);
  const path = join(directory, portfolioSpoolName(digest));
  const temporary = `${path}.partial`;
  const file = await open(temporary, "w", SPOOL_FILE_MODE);
  try {
    await file.write(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  return { path, digest };
}

/** The unconsumed spool files, oldest name first, bounded. Partial writes are never listed. */
export async function listPortfolioSpoolFiles(directory: string): Promise<readonly string[]> {
  let entries: readonly Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new JarvisError("PORTFOLIO_SPOOL_UNAVAILABLE");
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(PORTFOLIO_SPOOL_SUFFIX))
    .map(entry => entry.name)
    .sort()
    .slice(0, PORTFOLIO_SPOOL_MAX_FILES);
}

/** True when this digest has already been consumed. The ledger is the processed directory itself. */
export async function portfolioSpoolConsumed(directory: string, digest: string): Promise<boolean> {
  try {
    return (await stat(join(directory, PORTFOLIO_SPOOL_PROCESSED, portfolioSpoolName(digest)))).isFile();
  } catch {
    return false;
  }
}

/**
 * Moves a consumed or refused spool file into its subdirectory, atomically. A rename that loses a
 * race with another ingest leaves nothing behind either way, so the file is removed rather than
 * reported: both outcomes mean this ingest is not the one that owns the envelope.
 */
export async function movePortfolioSpoolFile(input: {
  readonly directory: string;
  readonly name: string;
  readonly into: typeof PORTFOLIO_SPOOL_PROCESSED | typeof PORTFOLIO_SPOOL_REFUSED;
  readonly as?: string | undefined;
}): Promise<string> {
  const destination = join(input.directory, input.into);
  await mkdir(destination, { recursive: true, mode: SPOOL_DIRECTORY_MODE });
  const target = join(destination, input.as ?? input.name);
  await rename(join(input.directory, input.name), target);
  return target;
}

export async function removePortfolioSpoolFile(directory: string, name: string): Promise<void> {
  try {
    await unlink(join(directory, name));
  } catch {
    // Another ingest consumed it first; there is nothing left to remove and nothing to report.
  }
}
