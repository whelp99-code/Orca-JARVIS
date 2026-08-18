import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import {
  ApprovedCommandExecutor,
  ControlPlane,
  signCommandApproval,
  type CommandApprovalReceipt,
  type ControlCommandRequestInput,
  type StoredControlCommand,
} from "../../src/index.js";
import { LoopGraph } from "../../src/loopgraph.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { initialized, localKey } from "../helpers.js";

const CSRF = "X-JARVIS-CSRF";
const JSON_TYPE = "application/json";
const NOW = new Date("2026-08-18T12:00:00.000Z");
const AT = NOW.toISOString();
const EXPIRES = "2026-08-18T12:15:00.000Z";
const DEADLINE = "2026-08-18T18:00:00.000Z";
const LOOP = "agentops-default";
const REQUESTED_BY = "jarvis-control-center";
const dirs = new Set<string>();
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

async function readyDb() {
  const db = await initialized();
  dirs.add(dirname(db.filename));
  return db;
}

function startServer(db: Awaited<ReturnType<typeof readyDb>>): DashboardServer {
  const root = mkdtempSync(join(tmpdir(), "jarvis-dashboard-cancel-retry-"));
  dirs.add(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
  return createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0, clock: () => NOW });
}

function origin(server: DashboardServer): string {
  if (server.address.family !== "IPv4") throw new Error("dashboard server must bind loopback IPv4 only");
  return `http://${server.address.host}:${server.address.port}`;
}

function parseJson(text: string): unknown { return JSON.parse(text); }
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object");
  return Object.fromEntries(Object.entries(value));
}
function errorCode(body: unknown): string { return String(asRecord(asRecord(body).error).code); }
function fingerprint(db: Awaited<ReturnType<typeof readyDb>>): string {
  return JSON.stringify({
    requests: db.db.prepare("SELECT request_id,state,lease_fence,completed_at,failure_code FROM control_command_requests ORDER BY request_id").all(),
    counts: db.db.prepare("SELECT (SELECT COUNT(*) FROM control_command_receipts) AS receipts, (SELECT COUNT(*) FROM control_command_redemptions) AS redemptions, (SELECT COUNT(*) FROM control_command_effects) AS effects, (SELECT COUNT(*) FROM control_command_revocations) AS revocations, (SELECT COUNT(*) FROM workflow_runs) AS runs, (SELECT COUNT(*) FROM workflow_steps) AS steps, (SELECT COUNT(*) FROM workflow_transitions) AS transitions").get(),
    runs: db.db.prepare("SELECT run_id,state,current_node,completed_at FROM workflow_runs ORDER BY run_id").all(),
  });
}

type StartSpec = { readonly task_id: string; readonly run_id: string; readonly command: ControlCommandRequestInput };

function startSpec(id: string): StartSpec {
  const task_id = `task-${id}`;
  const run_id = `run-${id}`;
  return {
    task_id, run_id,
    command: {
      schema_version: 1, request_id: `req-${id}`, action: "workflow.start", action_level: 2,
      target: { environment: "local", run_id, loop_id: LOOP, correlation_id: task_id, task_id },
      args: { run_id, loop_id: LOOP, correlation_id: task_id, input: { task_id, objective: `Work ${id}` }, budget: { max_steps: 8, max_attempts_per_node: 2, deadline: DEADLINE } },
      reversible: true, requested_by: "test-operator", requested_at: AT, expires_at: EXPIRES, nonce: `nonce-${id}`,
    },
  };
}

function signed(db: Awaited<ReturnType<typeof readyDb>>, staged: StoredControlCommand): CommandApprovalReceipt {
  return signCommandApproval({
    schema_version: 1, receipt_id: `approval-${staged.request_id}`, request_id: staged.request_id, decision: "approve",
    command_digest: staged.command_digest, signer_principal_id: "test-operator", authenticated_session_id: "action-hub",
    key_id: "decision-test", algorithm: "Ed25519", issued_at: AT, not_before: AT, expires_at: staged.expires_at,
    nonce: `approval-${staged.request_id}`, max_uses: 1, status: "issued",
  }, localKey(db));
}

function executor(db: Awaited<ReturnType<typeof readyDb>>): ApprovedCommandExecutor {
  const root = mkdtempSync(join(tmpdir(), "jarvis-dashboard-executor-"));
  dirs.add(root);
  return new ApprovedCommandExecutor(db, join(root, "backups"), join(root, "state"), {}, () => NOW);
}

async function csrfToken(server: DashboardServer): Promise<string> {
  const response = await request(`${origin(server)}/api/v1/session`);
  const token = asRecord(parseJson(await response.body.text())).csrf_token;
  if (response.statusCode !== 200 || typeof token !== "string" || token.length < 32) throw new Error("session csrf required");
  return token;
}

async function post(
  server: DashboardServer,
  path: string,
  init: { readonly csrf: string; readonly body: unknown },
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await request(`${origin(server)}${path}`, {
    method: "POST",
    headers: { "content-type": JSON_TYPE, origin: origin(server), [CSRF]: init.csrf },
    body: JSON.stringify(init.body),
  });
  return { status: response.statusCode, body: parseJson(await response.body.text()) };
}

async function startActive(db: Awaited<ReturnType<typeof readyDb>>, id: string): Promise<StartSpec> {
  const spec = startSpec(id);
  new LoopGraph(db).ensureDefaults(NOW);
  const control = new ControlPlane(db);
  const staged = control.stage(spec.command, NOW);
  control.decide(signed(db, staged), NOW);
  const executed = await executor(db).execute(staged.request_id, "setup-executor", NOW);
  if (executed.state !== "completed") throw new Error("active run required");
  return spec;
}

async function failStart(db: Awaited<ReturnType<typeof readyDb>>, id: string): Promise<StoredControlCommand> {
  const control = new ControlPlane(db);
  const staged = control.stage(startSpec(id).command, NOW);
  control.decide(signed(db, staged), NOW);
  const executed = await executor(db).execute(staged.request_id, "setup-executor", NOW);
  if (executed.state !== "failed") throw new Error("failed source required");
  const listed = control.list();
  const failed = listed.find((item) => item.request_id === staged.request_id);
  if (failed === undefined) throw new Error("failed source missing");
  return failed;
}

describe("dashboard cancel and retry staging", () => {
  it("stages one pending level-3 workflow.cancel without mutating the active run", async () => {
    const db = await readyDb();
    const spec = await startActive(db, "cancel");
    const server = startServer(db);
    const body = { schema_version: 1, request_id: "req-cancel-new", nonce: "nonce-cancel-new", run_id: spec.run_id, reason: "operator cancelled the task" };
    try {
      const posted = await post(server, `/api/v1/tasks/${spec.task_id}/cancel`, { csrf: await csrfToken(server), body });
      expect(posted.status).toBe(202);
      expect(asRecord(posted.body).schema_version).toBe(1);
      const staged = new ControlPlane(db).list().find((item) => item.request_id === body.request_id);
      expect(staged).toMatchObject({
        action: "workflow.cancel", action_level: 3, state: "pending", reversible: true,
        requested_by: REQUESTED_BY, requested_at: AT, expires_at: EXPIRES,
        request_id: body.request_id, nonce: body.nonce,
        target: { environment: "local", run_id: spec.run_id, task_id: spec.task_id },
        args: { run_id: spec.run_id, reason: body.reason, task_id: spec.task_id },
      });
      expect(new LoopGraph(db).get(spec.run_id)).toMatchObject({ state: "running", current_node: "observe" });
      expect(parseJson(fingerprint(db))).toMatchObject({ counts: { redemptions: 1, effects: 1, revocations: 0, runs: 1 } });
    } finally {
      server.close();
      db.close();
    }
  });

  it("rejects missing, terminal, and mismatched cancel targets with typed 404/409 and identical fingerprints", async () => {
    const db = await readyDb();
    const active = await startActive(db, "active");
    const terminal = await startActive(db, "terminal");
    new LoopGraph(db).advance({ run_id: terminal.run_id, outcome: "observed", output: {} }, NOW);
    new LoopGraph(db).advance({ run_id: terminal.run_id, outcome: "no_action", output: {} }, NOW);
    const server = startServer(db);
    const csrf = await csrfToken(server);
    try {
      const cases = [
        { path: `/api/v1/tasks/${terminal.task_id}/cancel`, status: 409, code: "CONTROL_STATE_CONFLICT", body: { schema_version: 1, request_id: "req-term", nonce: "nonce-term", run_id: terminal.run_id, reason: "already complete" } },
        { path: `/api/v1/tasks/${active.task_id}/cancel`, status: 409, code: "CONTROL_STATE_CONFLICT", body: { schema_version: 1, request_id: "req-mis", nonce: "nonce-mis", run_id: "run-other", reason: "mismatched run" } },
        { path: "/api/v1/tasks/task-missing/cancel", status: 404, code: "TASK_NOT_FOUND", body: { schema_version: 1, request_id: "req-miss", nonce: "nonce-miss", run_id: "run-missing", reason: "missing task" } },
      ];
      for (const fixture of cases) {
        const before = fingerprint(db);
        const posted = await post(server, fixture.path, { csrf, body: fixture.body });
        expect({ status: posted.status, code: errorCode(posted.body) }).toEqual({ status: fixture.status, code: fixture.code });
        expect(fingerprint(db)).toBe(before);
      }
    } finally {
      server.close();
      db.close();
    }
  });

  it("retries a failed executable request by copying action fields and fixing requester time", async () => {
    const db = await readyDb();
    const failed = await failStart(db, "retry-src");
    const server = startServer(db);
    const body = { schema_version: 1, request_id: "req-retry-new", nonce: "nonce-retry-new" };
    try {
      const posted = await post(server, `/api/v1/control/requests/${failed.request_id}/retry`, { csrf: await csrfToken(server), body });
      expect(posted.status).toBe(202);
      expect(asRecord(posted.body).schema_version).toBe(1);
      const listed = new ControlPlane(db).list();
      expect(listed).toHaveLength(2);
      expect(listed.find((item) => item.request_id === failed.request_id)).toMatchObject({ state: "failed" });
      expect(listed.find((item) => item.request_id === body.request_id)).toMatchObject({
        action: failed.action, action_level: failed.action_level, target: failed.target, args: failed.args,
        reversible: failed.reversible, state: "pending", requested_by: REQUESTED_BY, requested_at: AT, expires_at: EXPIRES,
        request_id: body.request_id, nonce: body.nonce,
      });
    } finally {
      server.close();
      db.close();
    }
  });

  it("rejects uncertain and non-failed retry sources with 409 RETRY_NOT_ALLOWED and identical fingerprints", async () => {
    const db = await readyDb();
    const control = new ControlPlane(db);
    const pending = control.stage(startSpec("pending").command, NOW);
    const uncertainSpec = startSpec("uncertain");
    const uncertain = control.stage(uncertainSpec.command, NOW);
    control.decide(signed(db, uncertain), NOW);
    const claimed = control.claim(uncertain.request_id, "setup-executor", NOW);
    control.settle(uncertain.request_id, claimed.fence, { state: "uncertain", effect_type: "command.uncertain", payload: {}, failure_code: "TEST_UNCERTAIN" }, NOW);
    const server = startServer(db);
    const csrf = await csrfToken(server);
    try {
      for (const sourceId of [uncertain.request_id, pending.request_id]) {
        const before = fingerprint(db);
        const posted = await post(server, `/api/v1/control/requests/${sourceId}/retry`, { csrf, body: { schema_version: 1, request_id: `req-retry-${sourceId}`, nonce: `nonce-retry-${sourceId}` } });
        expect(posted.status).toBe(409);
        expect(errorCode(posted.body)).toBe("RETRY_NOT_ALLOWED");
        expect(fingerprint(db)).toBe(before);
      }
    } finally {
      server.close();
      db.close();
    }
  });
});
