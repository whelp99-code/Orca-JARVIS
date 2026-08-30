import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { AuthorityDb, DailyControlLoop, DailyLoopStore } from "../../src/index.js";

type WorkerResult = { readonly kind: "result"; readonly ok: boolean; readonly fence?: number; readonly code?: string };
const workerUrl = new URL("../../scripts/task20-race-worker.mjs", import.meta.url);
const options = (clock: () => Date) => ({
  time_zone: "Asia/Seoul" as const, owner_id: "parent", lease_ms: 1_000, deadline_ms: 60_000,
  recovery_window_ms: 86_400_000, recovery_lookback_days: 2, refresh_freshness_ms: 60_000,
  budgets: { max_items: 8, max_work: 8, max_bytes: 4096 }, clock,
  event_source: { drain: () => [] }, refresh_reader: { read: () => null },
});
const race = async (path: string, runId: string, at: string): Promise<readonly WorkerResult[]> => {
  const workers = ["worker:a", "worker:b"].map(owner => new Worker(workerUrl, { workerData: { path, runId, at, owner, leaseMs: 1_000 } }));
  try {
    const ready = workers.map(worker => new Promise<void>((resolve, reject) => {
      const onMessage = (message: { readonly kind?: string }): void => { if (message.kind === "ready") { worker.off("error", reject); resolve(); } };
      worker.once("message", onMessage); worker.once("error", reject);
    }));
    await Promise.all(ready);
    const results = workers.map(worker => new Promise<WorkerResult>((resolve, reject) => {
      const onMessage = (message: WorkerResult): void => { if (message.kind === "result") { worker.off("error", reject); resolve(message); } };
      worker.once("message", onMessage); worker.once("error", reject);
    }));
    for (const worker of workers) worker.postMessage({ kind: "go" });
    return await Promise.all(results);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
};

describe("process-like Daily Loop contention", () => {
  it("releases two independent initial claimants together and persists one sequence-one append", async () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), "task20-initial-race-")); const path = join(root, "authority.sqlite"); const db = new AuthorityDb(path);
    try {
      await db.migrate(); const at = new Date("2026-08-30T22:15:00.000Z"); const loop = new DailyControlLoop(new DailyLoopStore(db), options(() => at)); const prepared = loop.prepare({ kind: "scheduled" }); if (prepared.kind !== "prepared") throw new Error("not prepared");
      // When
      const results = await race(path, prepared.run_id, at.toISOString());
      // Then
      expect(results.filter(result => result.ok)).toHaveLength(1); expect(results.filter(result => !result.ok)).toEqual([{ kind: "result", ok: false, code: "DAILY_LOOP_LEASE_ACTIVE" }]); expect(db.db.prepare("SELECT lease_fence,state FROM daily_loop_runs WHERE run_id=?").get(prepared.run_id)).toEqual({ lease_fence: 1, state: "running" }); expect(db.db.prepare("SELECT sequence,state FROM daily_loop_checkpoints WHERE run_id=?").all(prepared.run_id)).toEqual([{ sequence: 1, state: "running" }]); db.close(); const reopened = new AuthorityDb(path); expect(reopened.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints GROUP BY previous_digest HAVING count(*)>1").all()).toEqual([]); reopened.close();
    } finally { try { db.close(); } catch { /* closed */ } rmSync(root, { recursive: true, force: true }); }
  });

  it("releases two expired reclaimants together and advances exactly one fence", async () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), "task20-reclaim-race-")); const path = join(root, "authority.sqlite"); const db = new AuthorityDb(path);
    try {
      await db.migrate(); const initial = new Date("2026-08-30T22:15:00.000Z"); const loop = new DailyControlLoop(new DailyLoopStore(db), options(() => initial)); const prepared = loop.prepare({ kind: "scheduled" }); if (prepared.kind !== "prepared") throw new Error("not prepared"); const first = loop.claim(prepared.run_id);
      // When
      const results = await race(path, prepared.run_id, first.lease_expires_at);
      // Then
      expect(results.filter(result => result.ok).map(result => result.fence)).toEqual([2]); expect(results.filter(result => !result.ok)).toEqual([{ kind: "result", ok: false, code: "DAILY_LOOP_LEASE_ACTIVE" }]); expect(db.db.prepare("SELECT lease_fence,state FROM daily_loop_runs WHERE run_id=?").get(prepared.run_id)).toEqual({ lease_fence: 2, state: "running" }); expect(db.db.prepare("SELECT sequence,lease_fence FROM daily_loop_checkpoints WHERE run_id=?").all(prepared.run_id)).toEqual([{ sequence: 1, lease_fence: 2 }]); db.close(); const reopened = new AuthorityDb(path); expect(reopened.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints GROUP BY previous_digest HAVING count(*)>1").all()).toEqual([]); reopened.close();
    } finally { try { db.close(); } catch { /* closed */ } rmSync(root, { recursive: true, force: true }); }
  });
});
