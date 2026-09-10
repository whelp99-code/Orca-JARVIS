import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { applyLocalObservationRetention } from "../../src/local-observation-retention.js";
import { localObservationChain } from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) if (db.db.open) db.close(); });

const sha = (path: string): string | null =>
  existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
const sidecars = (path: string): Record<string, string | null> =>
  Object.fromEntries(["-wal", "-shm", "-journal"].map(suffix => [suffix, sha(`${path}${suffix}`)]));
const observations = (db: AuthorityDb): number =>
  Number(db.db.prepare("SELECT COUNT(*) FROM personal_observations").pluck().get());

/** A source holding one full observation chain, plus the cutoff that selects that chain. */
async function source() {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const chain = await localObservationChain(db);
  const cutoff = String(db.db.prepare("SELECT expires_at FROM personal_observations WHERE observation_id=?")
    .pluck().get(chain.observation.id));
  return { db, root: dirname(db.filename), cutoff };
}

// The destination is removed with rmSync(force) inside the rebuild adapter, so a destination that
// names the source by another spelling deletes the source outright. String inequality is not
// file inequality: only real-path identity and exclusive creation can decide ownership.
it("refuses every spelling of the source instead of deleting it", async () => {
  const { db, root, cutoff } = await source();
  const before = sha(db.filename);
  const beforeSidecars = sidecars(db.filename);
  const rows = observations(db);
  const link = join(root, "alias-link.sqlite");
  symlinkSync(db.filename, link);

  for (const alias of [db.filename, `${root}/./${basename(db.filename)}`,
    join(root, "nested", "..", basename(db.filename)), relative(process.cwd(), db.filename), link]) {
    await expect(applyLocalObservationRetention(db, cutoff, alias))
      .rejects.toThrow("LOCAL_RETENTION_DESTINATION_INVALID");
  }

  expect(existsSync(db.filename)).toBe(true);
  expect(sha(db.filename)).toBe(before);
  expect(sidecars(db.filename)).toEqual(beforeSidecars);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  const reopened = new AuthorityDb(db.filename); opened.push(reopened);
  expect(observations(reopened)).toBe(rows);
});

it("refuses a destination that already exists and preserves it byte for byte", async () => {
  const { db, root, cutoff } = await source();
  const text = join(root, "existing.txt");
  writeFileSync(text, "owned existing destination sentinel");
  const occupied = new AuthorityDb(join(root, "existing.sqlite")); opened.push(occupied);
  await occupied.migrate();
  occupied.db.pragma("wal_checkpoint(TRUNCATE)");
  // A stale sidecar with no main file is still someone else's material: SQLite would recover from
  // it, so the claim has to refuse rather than build on top of it.
  const orphan = join(root, "orphan.sqlite");
  writeFileSync(`${orphan}-wal`, "stale sidecar");
  const before = { text: sha(text), occupied: sha(occupied.filename) };

  for (const destination of [text, occupied.filename, orphan]) {
    await expect(applyLocalObservationRetention(db, cutoff, destination))
      .rejects.toThrow("LOCAL_RETENTION_DESTINATION_INVALID");
  }

  expect(sha(text)).toBe(before.text);
  expect(readFileSync(text, "utf8")).toBe("owned existing destination sentinel");
  expect(sha(occupied.filename)).toBe(before.occupied);
  expect(existsSync(orphan)).toBe(false);
  expect(readFileSync(`${orphan}-wal`, "utf8")).toBe("stale sidecar");
});

// Two callers naming the same destination must not both believe they own it. The claim is taken
// before the first await, so the second call loses deterministically without any timer.
it("gives exactly one of two racing calls the destination", async () => {
  const { db, root, cutoff } = await source();
  const destination = join(root, "raced.sqlite");
  const results = await Promise.allSettled([
    applyLocalObservationRetention(db, cutoff, destination),
    applyLocalObservationRetention(db, cutoff, destination)]);

  expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  const rejected = results.find(result => result.status === "rejected");
  expect(String(rejected instanceof Object && "reason" in rejected ? rejected.reason : ""))
    .toContain("LOCAL_RETENTION_DESTINATION_INVALID");
  const rebuilt = new AuthorityDb(destination); opened.push(rebuilt);
  expect(observations(rebuilt)).toBe(0);
  expect(observations(db)).toBe(1);
});
