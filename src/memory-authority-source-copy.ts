import type Database from "better-sqlite3";

/**
 * Copies the source's rows into the candidate and reports the source version that copy was read
 * at.
 *
 * The version is taken before a single byte moves, and the whole copy runs in one transaction.
 * Both halves matter: a commit that lands while this runs is in the live source and in no part of
 * this candidate, so reporting the version afterwards would let a later comparison call the two
 * "unchanged", and copying table by table without a transaction would let that same commit appear
 * in the tables whose turn had not come yet.
 */
export function copySourceTables(input: {
  readonly fresh: Database.Database;
  readonly sourceVersion: number;
  readonly sourceFilename: string;
  readonly copy: () => void;
}): number {
  input.fresh.prepare("ATTACH DATABASE ? AS source_authority").run(input.sourceFilename);
  input.fresh.exec("BEGIN");
  try {
    input.copy();
    input.fresh.exec("COMMIT");
  } catch (error) {
    input.fresh.exec("ROLLBACK");
    throw error;
  } finally {
    input.fresh.exec("DETACH DATABASE source_authority");
  }
  return input.sourceVersion;
}
