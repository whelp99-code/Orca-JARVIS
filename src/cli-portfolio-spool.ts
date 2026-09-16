import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JarvisError } from "./db.js";
import { verifyPortfolioAuthenticatedReport } from "./dashboard/portfolio-auth.js";
import { PORTFOLIO_MAX_BYTES, type PortfolioEnvironment } from "./dashboard/portfolio-contracts.js";
import type { PortfolioProjection } from "./dashboard/portfolio-projection.js";
import {
  PORTFOLIO_SPOOL_PROCESSED,
  PORTFOLIO_SPOOL_REFUSED,
  listPortfolioSpoolFiles,
  movePortfolioSpoolFile,
  portfolioSpoolConsumed,
  portfolioSpoolDigest,
  portfolioSpoolName,
  removePortfolioSpoolFile,
} from "./dashboard/portfolio-spool.js";

export type PortfolioSpoolRefusal = { readonly file: string; readonly code: string };
export type PortfolioSpoolIngestResult = {
  readonly spool: string;
  readonly ingested: number;
  readonly duplicates: number;
  readonly refused: readonly PortfolioSpoolRefusal[];
};

async function spoolBytes(directory: string, name: string): Promise<Buffer> {
  const bytes = await readFile(join(directory, name));
  if (bytes.byteLength < 1 || bytes.byteLength > PORTFOLIO_MAX_BYTES) {
    throw new JarvisError("PORTFOLIO_INPUT_INVALID");
  }
  return bytes;
}

/**
 * Consumes one bounded batch of spool files written by `portfolio collect`.
 *
 * Idempotence has two independent guards, because the database write and the rename that records it
 * cannot be one transaction. The ledger is the `processed/` directory, keyed by the envelope's own
 * digest: a file whose digest is already there is dropped without being verified again. If a crash
 * lands between the write and the rename, the envelope is re-verified and re-ingested, and the
 * projection's own replay rule makes that a no-op - an identical report at an identical
 * `reported_at` is accepted as `idempotent`, and a changed one is refused as a replay conflict.
 *
 * A malformed, mis-signed, stale or wrong-source envelope is refused and quarantined under
 * `refused/`, and reported by name and code. One bad file does not stop the batch and is never
 * retried in silence: the lane keeps running, and the operator has the evidence.
 */
export async function ingestPortfolioSpool(input: {
  readonly directory: string;
  readonly source: PortfolioEnvironment;
  readonly key: Buffer;
  readonly projection: PortfolioProjection;
  readonly now: Date;
}): Promise<PortfolioSpoolIngestResult> {
  const { directory, source, key, projection, now } = input;
  const refused: PortfolioSpoolRefusal[] = [];
  let ingested = 0;
  let duplicates = 0;
  for (const name of await listPortfolioSpoolFiles(directory)) {
    let digest: string;
    try {
      const bytes = await spoolBytes(directory, name);
      digest = portfolioSpoolDigest(bytes);
      if (await portfolioSpoolConsumed(directory, digest)) {
        await removePortfolioSpoolFile(directory, name);
        duplicates += 1;
        continue;
      }
      const verified = verifyPortfolioAuthenticatedReport(bytes, key, source);
      const payload = verified.kind === "report" ? verified.report : verified.error;
      projection.ingest(source, Buffer.from(JSON.stringify(payload), "utf8"), now);
    } catch (error) {
      refused.push({ file: name, code: error instanceof JarvisError ? error.code : "PORTFOLIO_INPUT_INVALID" });
      await movePortfolioSpoolFile({ directory, name, into: PORTFOLIO_SPOOL_REFUSED });
      continue;
    }
    await movePortfolioSpoolFile({
      directory, name, into: PORTFOLIO_SPOOL_PROCESSED, as: portfolioSpoolName(digest),
    });
    ingested += 1;
  }
  return { spool: directory, ingested, duplicates, refused };
}
