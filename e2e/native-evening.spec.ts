import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { taskPublicationFixture } from "../tests/fixtures/task-publication-fixture.js";
import { publishTaskGitCandidate } from "../src/task-git-publication.js";
import { settleTaskExecution } from "../src/task-completion.js";
import { DailyLoopStore } from "../src/daily-loop-store.js";
import { NativeEveningStore } from "../src/evening-native-store.js";
import { generateNativeEveningEnvelope } from "../src/evening-native-envelope.js";
import { MemoryProjectionAuthority } from "../src/memory-projection-authority.js";
import { kstLocalDate } from "../src/daily-loop-time.js";
import { signer, trustedCloseoutKey } from "../tests/fixtures/evening-closeout.js";
import { SECOND_SOURCE_TARGET } from "../tests/fixtures/morning-publication.js";
import { createDashboardServer } from "../src/dashboard/server.js";

// Synthetic certification and provenance; real Git, SQLite, HTTP and Chromium.
test("Today renders a native completion and removes it after source quarantine and reload", async ({ page }) => {
  const f = await taskPublicationFixture();
  let server: ReturnType<typeof createDashboardServer> | undefined;
  try {
    const input = await f.certify();
    const publication = await publishTaskGitCandidate(input);
    await settleTaskExecution({ ...input, publication_id: publication.publication_id });
    const date = kstLocalDate(f.now);
    const loop = new DailyLoopStore(f.db);
    const runId = loop.prepare({ due: { kind: "due", local_date: date, phase: "evening", scheduled_at: f.now.toISOString() },
      created_at: f.now, deadline_at: new Date(f.now.getTime() + 60000), steps: [{ key: "evening_summary", sequence: 1 }] });
    const claim = loop.claim({ run_id: runId, owner_id: "native-browser", at: f.now, lease_ms: 30000 })!;
    const config = { repository_identities: [f.plan.publication.repository_identity], max_records: 10, max_bytes: 1048576 };
    const row = f.db.db.prepare("SELECT correlation_id FROM daily_loop_runs WHERE run_id=?").get(runId) as { correlation_id: string };
    const artifact = generateNativeEveningEnvelope(f.db, { ...config, run_id: runId, correlation_id: row.correlation_id,
      local_date: date, observed_at: f.now }, signer(f.now.toISOString()));
    const projections = new MemoryProjectionAuthority(f.db);
    projections.bind({ kind: "control_payload", id: "execute", component_id: "execute" },
      [{ target_digest: SECOND_SOURCE_TARGET, source_identity_digest: `sha256:${"b".repeat(64)}` }], f.now);
    new NativeEveningStore(f.db, trustedCloseoutKey, config, () => f.now).settleWithinBudget({ claim, artifact },
      { max_items: 1, max_work: 1, max_bytes: 1048576 });
    server = createDashboardServer({ db: f.db, staticRoot: resolve("dist/dashboard"), host: "127.0.0.1", port: 0,
      clock: () => f.now, trustedCloseoutKey, nativeCloseoutSource: config });
    const origin = `http://127.0.0.1:${server.address.port}`;
    const response = await page.request.get(`${origin}/api/v1/today`);
    expect(response.status()).toBe(200);
    expect((await response.json()).latest_verified_closeout).toMatchObject({ artifact_id: artifact.artifact_id,
      verified_completion_count: 1, source_readiness: "degraded" });
    await page.goto(origin);
    await expect(page.getByText("1 verified", { exact: true })).toBeVisible();
    projections.quarantineUnresolved({ kind: "control_payload", id: "execute", component_id: "execute" }, f.now);
    const hidden = await page.request.get(`${origin}/api/v1/today`);
    expect(hidden.status()).toBeGreaterThanOrEqual(400);
    expect(await hidden.text()).not.toContain(artifact.artifact_id);
    await page.reload();
    await expect(page.getByText("Today is unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText("1 verified", { exact: true })).toHaveCount(0);
  } finally {
    await page.close();
    server?.close();
    await f.cleanup();
  }
});
