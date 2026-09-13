import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
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
  await localObservationChain(db);
  // Past both of the chain's observations: a cutoff reaching only the local collection leaves the
  // live fact it was cited beside still current, and the group is correctly retained instead.
  const cutoff = String(db.db.prepare("SELECT MAX(expires_at) FROM personal_observations").pluck().get());
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
  const before = { text: sha(text), occupied: sha(occupied.filename) };

  // The operation creates a directory, so any name already taken by a file loses the claim and
  // keeps its contents.
  for (const destination of [text, occupied.filename]) {
    await expect(applyLocalObservationRetention(db, cutoff, destination))
      .rejects.toThrow("LOCAL_RETENTION_DESTINATION_INVALID");
  }

  expect(sha(text)).toBe(before.text);
  expect(readFileSync(text, "utf8")).toBe("owned existing destination sentinel");
  expect(sha(occupied.filename)).toBe(before.occupied);
});

it("ignores a stale sidecar beside the name and never writes through it", async () => {
  const { db, root, cutoff } = await source();
  // A sidecar with no database was dangerous while the artifact was a file at that name: SQLite
  // would have recovered from it. The artifacts live inside the directory now, so it is somebody
  // else's file next door - to be left exactly as it is.
  const destination = join(root, "beside-a-sidecar");
  writeFileSync(`${destination}-wal`, "stale sidecar");

  const applied = await applyLocalObservationRetention(db, cutoff, destination);

  // The operation builds under its own name; the announced destination is never created, so the
  // sidecar beside that name is untouched and nothing was ever written through it.
  expect(applied.build.fresh_path).toBe(applied.operation.candidate_path);
  expect(existsSync(destination)).toBe(false);
  expect(readFileSync(`${destination}-wal`, "utf8")).toBe("stale sidecar");
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
  // The winner announced the destination exclusively in the ledger; what it actually built lives
  // under its own name, which is where the rebuilt database is read from.
  const winner = results.find(result => result.status === "fulfilled");
  const built = winner !== undefined && winner.status === "fulfilled"
    ? winner.value.operation.candidate_path : "";
  const rebuilt = new AuthorityDb(built); opened.push(rebuilt);
  // The removed group takes the local collection; the live fact it was cited beside survives.
  expect(observations(rebuilt)).toBe(1);
  expect(observations(db)).toBe(2);
});

// Reported by review as P1-C1: a failed claim is not ownership, and the failure path was deleting
// whatever already held the name while returning the correct error.
it("leaves an occupied destination exactly as it was when the claim fails", async () => {
  const { db, root, cutoff } = await source();
  const occupiedDirectory = join(root, "occupied-directory");
  mkdirSync(occupiedDirectory);
  const sentinel = join(occupiedDirectory, "sentinel.txt");
  writeFileSync(sentinel, "not this run's file");
  const occupiedFile = join(root, "occupied-file");
  writeFileSync(occupiedFile, "not this run's file either");

  for (const destination of [occupiedDirectory, occupiedFile]) {
    await expect(applyLocalObservationRetention(db, cutoff, destination))
      .rejects.toThrow("LOCAL_RETENTION_DESTINATION_INVALID");
  }

  expect(existsSync(occupiedDirectory)).toBe(true);
  expect(readFileSync(sentinel, "utf8")).toBe("not this run's file");
  expect(readFileSync(occupiedFile, "utf8")).toBe("not this run's file either");
  // The refusal leaves no claim behind either.
  expect(db.db.prepare("SELECT COUNT(*) FROM local_retention_claim_intents").pluck().get()).toBe(0);
});

// Reported by review: the claim is now staged and renamed onto the destination, and rename is the
// one operation that would replace an empty directory rather than refuse it. The name is refused
// before anything moves, so an empty directory standing there survives exactly like a full one.
it("refuses an empty directory standing at the destination and leaves it there", async () => {
  const { db, root, cutoff } = await source();
  const empty = join(root, "empty-destination");
  mkdirSync(empty);
  const before = statSync(empty, { bigint: true });

  await expect(applyLocalObservationRetention(db, cutoff, empty))
    .rejects.toMatchObject({ code: "LOCAL_RETENTION_DESTINATION_INVALID" });

  const after = statSync(empty, { bigint: true });
  expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
  expect(readdirSync(empty)).toEqual([]);
  // Nothing was announced either: the path is still free for whoever owns that directory.
  expect(Number(db.db.prepare("SELECT COUNT(*) FROM local_retention_claim_intents").pluck().get()))
    .toBe(0);
});
