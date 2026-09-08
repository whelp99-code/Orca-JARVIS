import { expect, it } from "vitest";
import { approvedTaskFixture } from "../fixtures/approved-task-fixture.js";
import { readClaudeTaskUsage } from "../../src/claude-task-usage.js";
import { readTaskPerformance } from "../../src/task-performance.js";
import { readTaskProviderUsage, recordTaskProviderUsage, taskUsageEventId, type TaskUsageAttempt } from "../../src/task-provider-usage.js";
import type { ClaimedControlCommand } from "../../src/control-plane.js";

const usage = readClaudeTaskUsage({ usage: { input_tokens: 4, output_tokens: 8,
  cache_read_input_tokens: 10, cache_creation_input_tokens: 12 }, total_cost_usd: .25 });
function attempt(f: Awaited<ReturnType<typeof approvedTaskFixture>>) {
  return f.db.db.prepare("SELECT * FROM control_effect_attempts WHERE effect_type='task.execute'").get() as TaskUsageAttempt;
}
function command(a: TaskUsageAttempt) {
  return { action: "task.execute", request_id: a.request_id, receipt_id: a.receipt_id, fence: a.lease_fence } as ClaimedControlCommand;
}
function report(f: Awaited<ReturnType<typeof approvedTaskFixture>>) {
  return readTaskPerformance(f.db, new Date(f.now.getTime() - 1000).toISOString(),
    new Date(f.now.getTime() + 2000).toISOString(), new Date(f.now.getTime() + 5000));
}
function attach(f: Awaited<ReturnType<typeof approvedTaskFixture>>, metadata: unknown = usage) {
  const generate = f.generate.getMockImplementation()!;
  f.generate.mockImplementation(async input => ({ ...await generate(input), usage: metadata }));
}

it("persists one invocation observation and reports its estimate once across execution replay", async () => {
  const f = await approvedTaskFixture();
  try {
    attach(f);
    expect((await f.executor.execute("execute", "usage", f.now)).state).toBe("completed");
    const a = attempt(f);
    expect(readTaskProviderUsage(f.db, a, f.now)).toEqual({ status: "observed", usage });
    const before = f.db.db.prepare("SELECT total_changes() AS n").get();
    const first = report(f);
    expect(first.provider_cost_estimate).toMatchObject({ attempts: 1, reported_estimates: 1,
      missing_estimates: 0, invalid_estimates: 0, observed_estimated_usd: .25,
      estimated_usd_per_verified_completion: .25, status: "estimated", billing_verified: false });
    expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    recordTaskProviderUsage(f.db, command(a), usage, true, new Date(f.now.getTime() + 3600000));
    expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    await f.executor.execute("execute", "replay", f.now);
    expect(report(f)).toEqual(first); expect(f.generate).toHaveBeenCalledTimes(1);
    expect(() => recordTaskProviderUsage(f.db, command(a), undefined, false, f.now)).toThrow("TASK_USAGE_REPLAY_CONFLICT");
    expect(() => recordTaskProviderUsage(f.db, { ...command(a), fence: a.lease_fence + 1 }, usage, true, f.now))
      .toThrow("TASK_USAGE_BINDING_INVALID");
    const id = taskUsageEventId(a.attempt_id);
    expect(() => f.db.db.prepare("UPDATE control_events SET payload_json='{}' WHERE event_id=?").run(id)).toThrow("immutable control event");
    expect(() => f.db.db.prepare("DELETE FROM control_events WHERE event_id=?").run(id)).toThrow("immutable control event");
  } finally { await f.cleanup(); }
});

it.each(["missing", "invalid", "error"])("reports %s coverage without inventing zero spend", async mode => {
  const f = await approvedTaskFixture();
  try {
    if (mode === "invalid") attach(f, { ...usage, extra: "unexpected" });
    if (mode === "error") f.generate.mockRejectedValue(new Error("provider disconnected"));
    await f.executor.execute("execute", "coverage", f.now);
    const r = report(f).provider_cost_estimate;
    expect(r.attempts).toBe(1); expect(r.reported_estimates).toBe(0);
    expect(r.observed_estimated_usd).toBeNull(); expect(r.estimated_usd_per_verified_completion).toBeNull();
    expect(r.status).toBe("incomplete_observations");
    expect(mode === "invalid" ? r.invalid_estimates : r.missing_estimates).toBe(1);
    const observed = readTaskProviderUsage(f.db, attempt(f), f.now);
    expect(observed).toEqual({ status: "unavailable", reason: mode === "error" ? "provider_result_unavailable"
      : mode === "invalid" ? "metadata_invalid" : "metadata_missing" });
  } finally { await f.cleanup(); }
});

it("retains reported spend for failed verification but cannot divide by zero successes", async () => {
  const f = await approvedTaskFixture(false);
  try {
    attach(f); await f.executor.execute("execute", "failed-check", f.now);
    expect(report(f).provider_cost_estimate).toMatchObject({ attempts: 1, reported_estimates: 1,
      observed_estimated_usd: .25, verified_completions: 0, estimated_usd_per_verified_completion: null,
      status: "no_verified_completions" });
  } finally { await f.cleanup(); }
});

it("records already incurred usage after cancellation without allowing verification or publication", async () => {
  const f = await approvedTaskFixture();
  try {
    const generate = f.generate.getMockImplementation()!;
    f.generate.mockImplementation(async input => {
      const result = await generate(input);
      f.control.cancel({ request_id: "execute", reason: "cancel after response", actor: "operator", revoked_at: f.now.toISOString() }, f.now);
      return { ...result, usage };
    });
    expect((await f.executor.execute("execute", "cancelled", f.now)).state).not.toBe("completed");
    expect(f.verify).not.toHaveBeenCalled();
    expect(readTaskProviderUsage(f.db, attempt(f), f.now)).toEqual({ status: "observed", usage });
    expect(report(f).provider_cost_estimate).toMatchObject({ observed_estimated_usd: .25, verified_completions: 0,
      estimated_usd_per_verified_completion: null });
  } finally { await f.cleanup(); }
});

it("fails closed on mismatched event metadata even when its JSON digest is intact", async () => {
  const f = await approvedTaskFixture();
  try {
    attach(f); await f.executor.execute("execute", "tamper", f.now);
    const a = attempt(f);
    // Isolated corruption fixture; production update/delete triggers are retained.
    f.db.db.exec("DROP TRIGGER control_events_immutable_update");
    f.db.db.prepare("UPDATE control_events SET subject='other-attempt' WHERE event_id=?").run(taskUsageEventId(a.attempt_id));
    expect(() => readTaskProviderUsage(f.db, a, f.now)).toThrow("TASK_USAGE_EVIDENCE_INVALID");
    expect(report(f).provider_cost_estimate).toMatchObject({ invalid_estimates: 1,
      estimated_usd_per_verified_completion: null, status: "incomplete_observations" });
  } finally { await f.cleanup(); }
});
