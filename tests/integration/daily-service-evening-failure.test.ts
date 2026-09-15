// A phase executor that refuses, through the compiled `service once`.
//
// The evening publication refuses a same-day completion whose control payload has no recorded
// projection provenance (evening-native-lineage, pinned by evening-native-store's "Missing recorded
// provenance is not invented"). That refusal is an EveningCloseoutError - neither DailyLoopError nor
// JarvisError - and the service used to flatten it to the opaque DAILY_LOOP_SERVICE_ERROR and leave
// the run `claimed` with a live lease and no failure code, so no later cycle could reach it and the
// operator had no reason to read. The refusal's own code now reaches the result, the run is failed
// under the claim the cycle holds, and the morning phase is untouched by any of it.
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { kstInstant, kstLocalDate } from "../../src/daily-loop-time.js";
import { AuthorityDb } from "../../src/db.js";
import { settleTaskExecution } from "../../src/task-completion.js";
import { publishTaskGitCandidate } from "../../src/task-git-publication.js";
import { dailyProductionChild } from "../fixtures/daily-production-chain.js";
import { taskPublicationFixture } from "../fixtures/task-publication-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/**
 * One same-day completion inside the configured repository scope, and no projection dependency
 * bound to its control payload - the state the production database was actually in.
 *
 * The publication fixture stamps its rows with the real clock, so the service clock is the evening
 * schedule of that same KST day, or a moment just after the completion when the schedule has
 * already passed. The recovery window is wide enough that the morning of the same day is recovered
 * and completed rather than recorded as missed, whatever hour the suite runs at.
 */
async function eveningRefusal() {
  const f = await taskPublicationFixture();
  cleanups.push(f.cleanup);
  const input = await f.certify();
  const publication = await publishTaskGitCandidate(input);
  await settleTaskExecution({ ...input, publication_id: publication.publication_id });
  const path = f.db.filename;
  const root = dirname(path);
  const date = kstLocalDate(f.now);
  const keys = generateKeyPairSync("ed25519");
  const key = join(root, "closeout.pem");
  writeFileSync(key, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const config = join(root, "service.json");
  writeFileSync(config, JSON.stringify({ schema_version: 1,
    daily: { time_zone: "Asia/Seoul", lease_ms: 300_000, deadline_ms: 900_000,
      recovery_window_ms: 72_000_000, recovery_lookback_days: 2, refresh_freshness_ms: 600_000,
      budgets: { max_items: 16, max_work: 16, max_bytes: 1_048_576 } },
    source: { repository_identities: [f.plan.publication.repository_identity],
      max_records: 10, max_bytes: 1_048_576 },
    trusted_key: { key_id: "native-service",
      public_key_spki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url") } }));
  const scheduled = kstInstant(date, 21, 30);
  const at = new Date(Math.max(scheduled.getTime(), f.now.getTime() + 1_000));
  expect(kstLocalDate(at)).toBe(date);
  f.db.close();
  return { path, date, at: at.toISOString(),
    args: ["service", "once", "--db", path, "--input", config, "--key-file", key] };
}

const runs = (path: string, date: string) => {
  const db = new AuthorityDb(path);
  try {
    return {
      phases: db.db.prepare(`SELECT phase,state,failure_code,lease_owner,lease_expires_at
        FROM daily_loop_runs WHERE loop_date=? ORDER BY phase`).all(date),
      published: Number(db.db.prepare("SELECT COUNT(*) FROM native_evening_publications").pluck().get()),
    };
  } finally { db.close(); }
};

it("fails the evening run with its own reason instead of leaving it claimed", async () => {
  const f = await eveningRefusal();

  const run = dailyProductionChild(["--input-type=module", "-e",
    `import { execute } from ${JSON.stringify(pathToFileURL(resolve("dist/src/cli.js")).href)};
     process.stdout.write(JSON.stringify(await execute(JSON.parse(process.argv[1]),
       { clock: () => new Date(process.argv[2]) })));`,
    JSON.stringify(f.args), f.at]);

  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  // The refusal's own code, not one opaque service error.
  expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, daily: { phases: {
    morning: { status: "processed" },
    evening: { status: "error", code: "EVENING_CLOSEOUT_INPUT_INVALID" } } } });
  const after = runs(f.path, f.date);
  expect(after.published).toBe(0);
  expect(after.phases).toEqual([
    // Failed, with its lease released, so the next cycle is free to reach this run again.
    { phase: "evening", state: "failed", failure_code: "EXECUTION_FAILED",
      lease_owner: null, lease_expires_at: null },
    // The morning of the same day published as it always did.
    { phase: "morning", state: "completed", failure_code: null,
      lease_owner: null, lease_expires_at: null },
  ]);
}, 120_000);
