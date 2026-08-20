import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { ControlPlane, type ControlCommandRequestInput } from "../../src/control-plane.js";
import { DataVersionObserver, DEFAULT_RECONCILE_TOPICS } from "../../src/dashboard/events.js";

const future = (minutes: number): string =>
  new Date(Date.parse("2026-08-18T00:00:00.000Z") + minutes * 60_000).toISOString();

function stagedRequest(): ControlCommandRequestInput {
  const taskId = "task:external-sse";
  const target = { environment: "local", run_id: "run:external-sse", loop_id: "agentops-default", correlation_id: taskId, task_id: taskId };
  const args = { run_id: target.run_id, loop_id: target.loop_id, correlation_id: taskId, input: { task_id: taskId, objective: "Observe external SQLite commit" }, budget: { max_steps: 8, max_attempts_per_node: 2, deadline: future(30) } };
  return { schema_version: 1, request_id: "request:external-sse", action: "workflow.start", action_level: 2, target, args, reversible: true, requested_by: "external-writer", requested_at: "2026-08-18T00:00:00.000Z", expires_at: future(10), nonce: "nonce:external-sse" };
}

describe("dashboard external SQLite reconciliation", () => {
  it("publishes canonical topic invalidation once for another connection commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-dashboard-data-version-"));
    const filename = join(root, "jarvis.sqlite");
    const reader = new AuthorityDb(filename);
    await reader.migrate();
    const writer = new AuthorityDb(filename);
    const published: Array<readonly string[]> = [];
    const observer = new DataVersionObserver(reader, (topics) => published.push(topics));
    try {
      expect(observer.check()).toBe(false);
      new ControlPlane(writer).stage(stagedRequest(), new Date("2026-08-18T00:05:00.000Z"));
      expect(observer.check()).toBe(true);
      expect(published).toEqual([DEFAULT_RECONCILE_TOPICS]);
      expect(observer.check()).toBe(false);
    } finally {
      observer.close();
      writer.close();
      reader.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
