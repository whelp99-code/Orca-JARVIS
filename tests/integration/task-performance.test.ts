import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import * as completionEvidence from "../../src/task-completion-evidence.js";
import { readTaskPerformance, taskPerformanceWindow } from "../../src/task-performance.js";
import { execute } from "../../src/cli.js";
import { approvedTaskFixture } from "../fixtures/approved-task-fixture.js";

function window(now: Date) { return [new Date(now.getTime() - 1000).toISOString(), new Date(now.getTime() + 2000).toISOString()] as const; }
function observe(now: Date) { return new Date(now.getTime() + 5000); }
function rawRequest(f: Awaited<ReturnType<typeof approvedTaskFixture>>, id: string, state: string, at: string) {
  // Synthetic non-success cohort rows; successful work uses the actual executor below.
  f.db.db.prepare(`INSERT INTO control_command_requests
    (request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,expires_at,nonce,state,created_at)
    VALUES(?,'task.execute',3,'{}','{}',?,0,'fixture',?,?,?, ?,?)`)
    .run(id, `digest:${id}`, at, new Date(f.now.getTime() + 60000).toISOString(), `nonce:${id}`, state, at);
}

it("measures a signed published completion once, preserves DB bytes logically, and excludes generic starts", async () => {
  const f = await approvedTaskFixture();
  try {
    f.setNow(new Date(f.now.getTime() + 1000));
    expect((await f.executor.execute("execute", "metrics-fixture", f.clock())).state).toBe("completed");
    const before = f.db.db.prepare("SELECT total_changes() AS n").get();
    const report = readTaskPerformance(f.db, ...window(f.now), observe(f.now));
    expect(report.requests).toBe(1); expect(report.verified_completions).toBe(1);
    expect(report.terminal_success).toEqual({ numerator: 1, denominator: 1, ratio: 1, status: "measured" });
    expect(report.completion_latency).toMatchObject({ samples: 1, p95: 1000, invalid_samples: 0 });
    expect(report.approval_wait).toMatchObject({ samples: 1, p95: 0 });
    expect(JSON.stringify(report)).not.toContain(f.root);
    expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect((await f.executor.execute("execute", "metrics-replay", f.clock())).state).toBe("completed");
    expect(readTaskPerformance(f.db, ...window(f.now), observe(f.now))).toEqual(report);
    expect(f.generate).toHaveBeenCalledTimes(1);
    const realEvidence = completionEvidence.readTaskCompletionEvidence(f.db, "execute", observe(f.now))!;
    const reader = vi.spyOn(completionEvidence, "readTaskCompletionEvidence").mockReturnValue({ ...realEvidence,
      completion: { ...realEvidence.completion, completed_at: new Date(f.now.getTime() - 1).toISOString() } });
    try {
      const reversed = readTaskPerformance(f.db, ...window(f.now), observe(f.now));
      expect(reversed.verified_completions).toBe(0);
      expect(reversed.unverified_completed_requests).toBe(1);
      expect(reversed.terminal_success.ratio).toBeNull();
      expect(reversed.completion_latency).toMatchObject({ samples: 0, invalid_samples: 1, p95: null });
    } finally { reader.mockRestore(); }
  } finally { await f.cleanup(); }
});

it("does not treat revoked completion evidence or uncertain outcomes as successful work", async () => {
  const f = await approvedTaskFixture();
  try {
    expect((await f.executor.execute("execute", "revoked-metrics", f.now)).state).toBe("completed");
    f.db.revokeAuthority("verifier-test", "metrics fixture revocation");
    for (const state of ["failed", "pending", "uncertain", "cancelled", "rejected"]) {
      rawRequest(f, state, state, f.now.toISOString());
    }
    const report = readTaskPerformance(f.db, ...window(f.now), observe(f.now));
    expect(report.requests).toBe(6); expect(report.verified_completions).toBe(0);
    expect(report.terminal_success).toEqual({ numerator: 0, denominator: 2, ratio: null, status: "invalid_completion_evidence" });
    expect(report.open_approval_age).toMatchObject({ samples: 1, p95: 5000 });
    expect(report.unavailable.cost_per_success).toBe("billing_usage_not_recorded");
    expect(report.policy_promoted).toBe(false);
  } finally { await f.cleanup(); }
});

it("uses a half-open cohort and rejects truncation rather than emitting a biased rate", async () => {
  const f = await approvedTaskFixture(false, { stage: false });
  try {
    const [from, to] = window(f.now);
    rawRequest(f, "left", "failed", from); rawRequest(f, "right", "failed", to);
    expect(readTaskPerformance(f.db, from, to, observe(f.now)).requests).toBe(1);
    const cli = JSON.parse(execFileSync(process.execPath, [resolve("dist/src/cli.js"), "report", "task-performance",
      from, f.now.toISOString(), "--db", f.db.filename], { encoding: "utf8" }));
    expect(cli.report.requests).toBe(1); expect(cli.report.terminal_success.ratio).toBe(0);
    f.db.db.transaction(() => { for (let i = 0; i < 1000; i++) rawRequest(f, `many-${i}`, "pending", from); })();
    expect(() => readTaskPerformance(f.db, from, to, observe(f.now))).toThrow("TASK_PERFORMANCE_COHORT_LIMIT");
  } finally { await f.cleanup(); }
});

it("keeps empty measurements null and validates CLI input before creating a database", async () => {
  const f = await approvedTaskFixture(false, { stage: false });
  try {
    const report = readTaskPerformance(f.db, ...window(f.now), observe(f.now));
    expect(report.requests).toBe(0); expect(report.terminal_success.ratio).toBeNull();
    expect(report.completion_latency.p95).toBeNull();
    const missing = join(f.root, "missing.sqlite");
    await expect(execute(["report", "task-performance", "invalid", "invalid", "--db", missing])).rejects.toThrow("TASK_PERFORMANCE_WINDOW_INVALID");
    await expect(execute(["report", "task-performance", ...window(f.now), "--db", missing], { clock: () => observe(f.now) }))
      .rejects.toThrow("TASK_PERFORMANCE_DATABASE_UNAVAILABLE");
    expect(existsSync(missing)).toBe(false);
    expect(() => taskPerformanceWindow(...window(f.now), new Date("invalid"))).toThrow("TASK_PERFORMANCE_WINDOW_INVALID");
  } finally { await f.cleanup(); }
});
