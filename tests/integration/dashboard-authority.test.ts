import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import {
  ControlPlane,
  signCommandApproval,
  type CommandApprovalReceipt,
  type ControlCommandRequestInput,
  type StoredControlCommand,
} from "../../src/index.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { initialized, localKey, untrustedKey } from "../helpers.js";

const CSRF = "X-JARVIS-CSRF";
const JSON_TYPE = "application/json";
const NOW = new Date("2026-08-18T12:00:00.000Z");
const AT = NOW.toISOString();
const EXPIRES = "2026-08-18T12:15:00.000Z";
const DEADLINE = "2026-08-18T18:00:00.000Z";
const LOOP = "agentops-default";
const ZERO = `sha256:${"0".repeat(64)}`;
const CONFLICT = new Set(["CONTROL_STATE_CONFLICT", "CONTROL_APPROVAL_NOT_APPLICABLE", "CONTROL_COMMAND_REPLAY_CONFLICT"]);
const dirs = new Set<string>();
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

async function readyDb() {
  const db = await initialized();
  dirs.add(dirname(db.filename));
  return db;
}

function startServer(db: Awaited<ReturnType<typeof readyDb>>): DashboardServer {
  const root = mkdtempSync(join(tmpdir(), "jarvis-dashboard-authority-"));
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
    receipts: db.db.prepare("SELECT receipt_id,request_id,decision FROM control_command_receipts ORDER BY receipt_id").all(),
    counts: db.db.prepare("SELECT (SELECT COUNT(*) FROM control_command_receipts) AS receipts, (SELECT COUNT(*) FROM control_command_redemptions) AS redemptions, (SELECT COUNT(*) FROM control_command_effects) AS effects, (SELECT COUNT(*) FROM control_command_revocations) AS revocations, (SELECT COUNT(*) FROM workflow_runs) AS runs, (SELECT COUNT(*) FROM workflow_steps) AS steps, (SELECT COUNT(*) FROM workflow_transitions) AS transitions, (SELECT COUNT(*) FROM loop_definitions) AS loops").get(),
    runs: db.db.prepare("SELECT run_id,state,current_node,completed_at FROM workflow_runs ORDER BY run_id").all(),
  });
}

function startCommand(id: string): ControlCommandRequestInput {
  const task_id = `task-${id}`;
  const run_id = `run-${id}`;
  return {
    schema_version: 1, request_id: `req-${id}`, action: "workflow.start", action_level: 2,
    target: { environment: "local", run_id, loop_id: LOOP, correlation_id: task_id, task_id },
    args: { run_id, loop_id: LOOP, correlation_id: task_id, input: { task_id, objective: `Work ${id}` }, budget: { max_steps: 8, max_attempts_per_node: 2, deadline: DEADLINE } },
    reversible: true, requested_by: "test-operator", requested_at: AT, expires_at: EXPIRES, nonce: `nonce-${id}`,
  };
}

function unsigned(staged: StoredControlCommand, decision: "approve" | "reject", overrides: Partial<Omit<CommandApprovalReceipt, "signature">> = {}): Omit<CommandApprovalReceipt, "signature"> {
  return {
    schema_version: 1, receipt_id: `${decision}-${staged.request_id}`, request_id: staged.request_id, decision,
    command_digest: staged.command_digest, signer_principal_id: "test-operator", authenticated_session_id: `session-secret-${staged.request_id}`,
    key_id: "decision-test", algorithm: "Ed25519", issued_at: AT, not_before: AT, expires_at: staged.expires_at,
    nonce: `approval-${staged.request_id}`, max_uses: 1, status: "issued", ...overrides,
  };
}

function signed(db: Awaited<ReturnType<typeof readyDb>>, staged: StoredControlCommand, decision: "approve" | "reject", overrides: Partial<Omit<CommandApprovalReceipt, "signature">> = {}): CommandApprovalReceipt {
  return signCommandApproval(unsigned(staged, decision, overrides), localKey(db));
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
  init: { readonly csrf: string; readonly body: string },
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await request(`${origin(server)}${path}`, {
    method: "POST",
    headers: { "content-type": JSON_TYPE, origin: origin(server), [CSRF]: init.csrf },
    body: init.body,
  });
  return { status: response.statusCode, body: parseJson(await response.body.text()) };
}

function assertSafe(body: unknown, secrets: readonly string[]): void {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/private_key|BEGIN [A-Z ]*PRIVATE KEY|csrf_token/i);
  for (const secret of secrets) expect(text).not.toContain(secret);
}

describe("dashboard receipt-bound decide and execute", () => {
  it("approves and rejects pending requests from valid externally signed receipts", async () => {
    for (const decision of ["approve", "reject"] as const) {
      const db = await readyDb();
      const staged = new ControlPlane(db).stage(startCommand(decision), NOW);
      const receipt = signed(db, staged, decision);
      const server = startServer(db);
      try {
        const posted = await post(server, `/api/v1/control/requests/${staged.request_id}/decision`, { csrf: await csrfToken(server), body: JSON.stringify({ schema_version: 1, receipt }) });
        expect(posted.status).toBe(200);
        expect(asRecord(posted.body)).toMatchObject({ schema_version: 1, request_id: staged.request_id, decision, state: decision === "approve" ? "approved" : "rejected" });
        expect(new ControlPlane(db).list()).toEqual([expect.objectContaining({ request_id: staged.request_id, state: decision === "approve" ? "approved" : "rejected" })]);
        assertSafe(posted.body, [receipt.signature, receipt.authenticated_session_id, receipt.nonce]);
      } finally {
        server.close();
        db.close();
      }
    }
  });

  it("rejects a missing receipt with 403 AUTHORITY_RECEIPT_REQUIRED and an identical fingerprint", async () => {
    const db = await readyDb();
    const staged = new ControlPlane(db).stage(startCommand("missing"), NOW);
    const server = startServer(db);
    const before = fingerprint(db);
    try {
      const posted = await post(server, `/api/v1/control/requests/${staged.request_id}/decision`, { csrf: await csrfToken(server), body: JSON.stringify({ schema_version: 1 }) });
      expect(posted.status).toBe(403);
      expect(errorCode(posted.body)).toBe("AUTHORITY_RECEIPT_REQUIRED");
      expect(fingerprint(db)).toBe(before);
      assertSafe(posted.body, []);
    } finally {
      server.close();
      db.close();
    }
  });

  it("rejects an invalid signature with 403 CONTROL_APPROVAL_INVALID and an identical fingerprint", async () => {
    const db = await readyDb();
    const staged = new ControlPlane(db).stage(startCommand("bad-sig"), NOW);
    const receipt = signCommandApproval(unsigned(staged, "approve"), untrustedKey());
    const server = startServer(db);
    const before = fingerprint(db);
    try {
      const posted = await post(server, `/api/v1/control/requests/${staged.request_id}/decision`, { csrf: await csrfToken(server), body: JSON.stringify({ schema_version: 1, receipt }) });
      expect(posted.status).toBe(403);
      expect(errorCode(posted.body)).toBe("CONTROL_APPROVAL_INVALID");
      expect(fingerprint(db)).toBe(before);
      assertSafe(posted.body, [receipt.signature, receipt.authenticated_session_id]);
    } finally {
      server.close();
      db.close();
    }
  });

  it("rejects URL, digest, and replay mismatches with 409 and identical fingerprints", async () => {
    const db = await readyDb();
    const control = new ControlPlane(db);
    const staged = control.stage(startCommand("mismatch"), NOW);
    const valid = signed(db, staged, "approve");
    const replayed = control.stage(startCommand("replay"), NOW);
    control.decide(signed(db, replayed, "approve"), NOW);
    const server = startServer(db);
    const csrf = await csrfToken(server);
    try {
      for (const fixture of [
        { path: "/api/v1/control/requests/req-other/decision", body: { schema_version: 1, receipt: valid } },
        { path: `/api/v1/control/requests/${staged.request_id}/decision`, body: { schema_version: 1, receipt: signed(db, staged, "approve", { command_digest: ZERO }) } },
        { path: `/api/v1/control/requests/${replayed.request_id}/decision`, body: { schema_version: 1, receipt: signed(db, replayed, "approve", { receipt_id: "replay-2", nonce: "approval-replay-2" }) } },
      ]) {
        const before = fingerprint(db);
        const posted = await post(server, fixture.path, { csrf, body: JSON.stringify(fixture.body) });
        expect(posted.status).toBe(409);
        expect([...CONFLICT]).toContain(errorCode(posted.body));
        expect(fingerprint(db)).toBe(before);
        assertSafe(posted.body, [valid.signature, valid.authenticated_session_id]);
      }
    } finally {
      server.close();
      db.close();
    }
  });

  it("refuses execute without approval and leaves the protected fingerprint unchanged", async () => {
    const db = await readyDb();
    const staged = new ControlPlane(db).stage(startCommand("no-approval"), NOW);
    const server = startServer(db);
    const before = fingerprint(db);
    try {
      const posted = await post(server, `/api/v1/control/requests/${staged.request_id}/execute`, { csrf: await csrfToken(server), body: JSON.stringify({ schema_version: 1 }) });
      expect(posted.status).toBe(403);
      expect(errorCode(posted.body)).toBe("CONTROL_APPROVAL_REQUIRED");
      expect(fingerprint(db)).toBe(before);
      expect(asRecord(asRecord(parseJson(before)).counts)).toMatchObject({ receipts: 0, redemptions: 0, effects: 0, runs: 0, loops: 0 });
    } finally {
      server.close();
      db.close();
    }
  });

  it("executes an approved workflow.start through ApprovedCommandExecutor and initializes agentops-default", async () => {
    const db = await readyDb();
    const control = new ControlPlane(db);
    const command = startCommand("exec");
    const staged = control.stage(command, NOW);
    control.decide(signed(db, staged, "approve"), NOW);
    const server = startServer(db);
    try {
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM loop_definitions").pluck().get()).toBe(0);
      const posted = await post(server, `/api/v1/control/requests/${staged.request_id}/execute`, { csrf: await csrfToken(server), body: JSON.stringify({ schema_version: 1 }) });
      expect(posted.status).toBe(200);
      expect(asRecord(posted.body)).toMatchObject({ schema_version: 1 });
      expect(asRecord(asRecord(posted.body).execution)).toMatchObject({ request_id: staged.request_id, action: "workflow.start", state: "completed" });
      expect(control.list()).toEqual([expect.objectContaining({ request_id: staged.request_id, state: "completed" })]);
      expect(parseJson(fingerprint(db))).toMatchObject({
        counts: { receipts: 1, redemptions: 1, effects: 1, revocations: 0, runs: 1, loops: 1 },
        runs: [{ run_id: "run-exec", state: "running", current_node: "observe", completed_at: null }],
      });
      expect(db.db.prepare("SELECT loop_id FROM loop_definitions WHERE loop_id=?").pluck().get(LOOP)).toBe(LOOP);
      expect(db.db.prepare("SELECT source FROM control_events WHERE event_type='control.command.claimed' AND subject=?").pluck().get(staged.request_id)).toBe("dashboard-approved-executor");
      assertSafe(posted.body, []);
    } finally {
      server.close();
      db.close();
    }
  });
});
