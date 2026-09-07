import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { ControlPlane, signCommandApproval } from "../../src/control-plane.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { initialized, localKey } from "../helpers.js";

const START = new Date("2026-09-07T10:00:00.000Z");
const DEADLINE = "2026-09-07T10:05:00.000Z";

describe("workflow retry deadline through HTTP", () => {
  it.each([
    { name: "one millisecond before", at: "2026-09-07T10:04:59.999Z", allowed: true },
    { name: "exactly at", at: DEADLINE, allowed: false },
    { name: "after", at: "2026-09-07T10:05:00.001Z", allowed: false },
    { name: "stale UI read", at: DEADLINE, readAt: "2026-09-07T10:04:59.999Z", allowed: false, displayedAllowed: true },
    { name: "invalid deadline", at: START.toISOString(), deadline: "invalid", allowed: false },
    { name: "zero step budget", at: START.toISOString(), allowed: false,
      budgetOverride: { max_steps: 0, max_attempts_per_node: 2, deadline: DEADLINE } },
    { name: "fractional attempts", at: START.toISOString(), allowed: false,
      budgetOverride: { max_steps: 8, max_attempts_per_node: 1.5, deadline: DEADLINE } },
    { name: "missing attempts", at: START.toISOString(), allowed: false,
      budgetOverride: { max_steps: 8, deadline: DEADLINE } },
    { name: "negative steps", at: START.toISOString(), allowed: false,
      budgetOverride: { max_steps: -1, max_attempts_per_node: 2, deadline: DEADLINE } },
  ])("checks the original deadline $name expiry without extending it", async ({ at, allowed, readAt, displayedAllowed, deadline, budgetOverride }) => {
    const db = await initialized();
    const control = new ControlPlane(db);
    const source = control.stage({
      schema_version: 1, request_id: "source", action: "workflow.start", action_level: 2,
      target: { environment: "local", task_id: "task", run_id: "run" },
      args: { run_id: "run", loop_id: "agentops-default", correlation_id: "task",
        input: { task_id: "task", objective: "Retry bounded work" },
        budget: budgetOverride === undefined
          ? { max_steps: 8, max_attempts_per_node: 2, deadline: deadline ?? DEADLINE } : budgetOverride },
      reversible: true, requested_by: "test-operator", requested_at: START.toISOString(),
      expires_at: "2026-09-07T10:10:00.000Z", nonce: "source-nonce",
    }, START);
    control.decide(signCommandApproval({
      schema_version: 1, receipt_id: "source-approval", request_id: source.request_id,
      decision: "approve", command_digest: source.command_digest,
      signer_principal_id: "test-operator", authenticated_session_id: "test-session",
      key_id: "decision-test", algorithm: "Ed25519", issued_at: START.toISOString(),
      not_before: START.toISOString(), expires_at: source.expires_at,
      nonce: "approval-nonce", max_uses: 1, status: "issued",
    }, localKey(db)), START);
    const claim = control.claim(source.request_id, "setup", START);
    control.settle(source.request_id, claim.fence, {
      state: "failed", effect_type: "command.failed", payload: {}, failure_code: "TEST_FAILURE",
    }, START);
    let clock = new Date(readAt ?? at);
    const server = createDashboardServer({ db, staticRoot: dirname(db.filename),
      host: "127.0.0.1", port: 0, clock: () => clock });
    const origin = `http://127.0.0.1:${server.address.port}`;
    try {
      const session = await request(`${origin}/api/v1/session`);
      const { csrf_token } = await session.body.json() as { csrf_token: string };
      const before = db.db.prepare("SELECT total_changes() AS n").get();
      const read = await request(`${origin}/api/v1/control/requests`);
      const body = await read.body.json() as { items: { request_id: string; retry_status?: string }[] };
      expect.soft(body.items.find(item => item.request_id === "source")?.retry_status)
        .toBe((displayedAllowed ?? allowed) ? "allowed" : "replan_required");
      expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
      clock = new Date(at);
      const retried = await request(`${origin}/api/v1/control/requests/source/retry`, {
        method: "POST", headers: { origin, "content-type": "application/json", "X-JARVIS-CSRF": csrf_token },
        body: JSON.stringify({ schema_version: 1, request_id: "retry", nonce: "retry-nonce" }),
      });
      const result = await retried.body.json();
      expect(retried.statusCode).toBe(allowed ? 202 : 409);
      if (allowed) {
        expect(control.get("retry")).toMatchObject({ state: "pending", args: source.args });
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts WHERE request_id='retry'").get())
          .toEqual({ n: 0 });
        const unapproved = await request(`${origin}/api/v1/control/requests/retry/execute`, {
          method: "POST", headers: { origin, "content-type": "application/json", "X-JARVIS-CSRF": csrf_token },
          body: JSON.stringify({ schema_version: 1 }),
        });
        expect(unapproved.statusCode).toBe(403);
        expect(await unapproved.body.json()).toMatchObject({ error: { code: "CONTROL_APPROVAL_REQUIRED" } });
      } else {
        expect(result).toMatchObject({ error: { code: "RETRY_REPLAN_REQUIRED" } });
        expect(control.get("retry")).toBeUndefined();
        expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
      }
      expect(control.get("source")).toMatchObject({ state: "failed", args: source.args });
    } finally {
      server.close(); db.close(); rmSync(dirname(db.filename), { recursive: true, force: true });
    }
  });
});
