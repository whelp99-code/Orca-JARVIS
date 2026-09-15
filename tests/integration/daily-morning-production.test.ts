import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import { closeMemoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { CLI_AT, CLI_AT_AGAIN, dailyProductionChild as child, HARNESS,
  prepareDailyProductionChain } from "../fixtures/daily-production-chain.js";

const databases: MemoryDatabase[] = [];
afterEach(() => { for (const database of databases.splice(0)) closeMemoryDatabase(database); });

const prepared = async (options: { readonly ownerDecision: "confirm" | "reject";
  readonly ownerAuthorization: boolean }) => {
  const f = await prepareDailyProductionChain(options);
  databases.push(f.database);
  return f;
};

const reopen = (path: string) => {
  const db = new AuthorityDb(path);
  const rows = Number(db.db.prepare("SELECT COUNT(*) FROM personal_recommendations").pluck().get());
  const brief = (todayProjection(db, new Date(CLI_AT)) as Record<string, unknown>)["brief"] as Record<string, unknown>;
  db.close();
  return { rows, brief };
};

// The product is supposed to produce the recommendation, not read one a fixture inserted. With the
// owner's confirmation on record, a write of ours that really settled, and a provider that serves
// that destination, one morning run has everything it needs.
it("produces a recommendation from stored evidence through the compiled daily CLI", async () => {
  const f = await prepared({ ownerDecision: "confirm", ownerAuthorization: true });
  const run = child([HARNESS, f.path, f.input, CLI_AT], f.provider);
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);

  const after = reopen(f.path);
  expect(after.rows).toBe(1);
  expect(after.brief).toMatchObject({ item_count: 1 });
}, 120_000);

// One morning produces once. A second invocation for the same local date must not leave a second
// recommendation behind, whatever it reports.
it("produces once for the day when the same morning is run again", async () => {
  const f = await prepared({ ownerDecision: "confirm", ownerAuthorization: true });
  const first = child([HARNESS, f.path, f.input, CLI_AT], f.provider);
  expect(first.stderr).toBe("");
  expect(first.status).toBe(0);

  const again = child([HARNESS, f.path, f.input, CLI_AT_AGAIN], f.provider);
  expect(again.status).toBe(0);

  const after = reopen(f.path);
  expect(after.rows).toBe(1);
  expect(after.brief).toMatchObject({ item_count: 1 });
}, 120_000);

// The same provider and the same confirmed memory, in a database where the owner authorized no
// workflow. JARVIS does not authorize itself, so there is nothing it may propose.
it("withholds when the owner authorized no workflow to propose within", async () => {
  const f = await prepared({ ownerDecision: "confirm", ownerAuthorization: false });
  const run = child([HARNESS, f.path, f.input, CLI_AT], f.provider);
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);

  const after = reopen(f.path);
  expect(after.rows).toBe(0);
  expect(after.brief).toMatchObject({ item_count: 0 });
}, 120_000);

// The same provider, serving the same record, against a database where the owner refused it. A
// record existing on the provider is not permission: the run must withhold rather than rest on it.
it("withholds and writes no recommendation when the owner never approved the memory", async () => {
  const f = await prepared({ ownerDecision: "reject", ownerAuthorization: true });
  const run = child([HARNESS, f.path, f.input, CLI_AT], f.provider);
  expect(run.status).toBe(0);

  const after = reopen(f.path);
  expect(after.rows).toBe(0);
  expect(after.brief).toMatchObject({ item_count: 0 });
}, 120_000);

// A deployment that names no memory provider is not a broken one. The run abstains from producing
// and still completes; it must not reach for a default launcher path on a host that never asked.
it("abstains without failing when the deployment names no memory provider", async () => {
  const f = await prepared({ ownerDecision: "confirm", ownerAuthorization: true });
  const run = child([HARNESS, f.path, f.input, CLI_AT]);
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);

  const after = reopen(f.path);
  expect(after.rows).toBe(0);
  expect(after.brief).toMatchObject({ item_count: 0 });
}, 120_000);
