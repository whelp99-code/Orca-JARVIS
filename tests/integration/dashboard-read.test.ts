import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import {
  AuthorityDb,
  ControlPlane,
  LiveSupervisor,
  canonicalize,
  signCommandApproval,
  type ControlCommandRequestInput,
} from "../../src/index.js";
import { SECRET_KEY_PATTERN } from "../../src/dashboard/contracts.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { future, initialized, localKey, tempDb } from "../helpers.js";

const temporaryDirectories = new Set<string>();

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function track(directory: string): string {
  temporaryDirectories.add(directory);
  return directory;
}

async function migratedDb(): Promise<AuthorityDb> {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  track(dirname(db.filename));
  return db;
}

function startServer(db: AuthorityDb): DashboardServer {
  const root = track(mkdtempSync(join(tmpdir(), "jarvis-dashboard-read-")));
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
  return createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0 });
}

function originOf(server: DashboardServer): string {
  if (server.address.family !== "IPv4") throw new Error("dashboard server must bind loopback IPv4 only");
  return `http://${server.address.host}:${server.address.port}`;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object");
  return Object.fromEntries(Object.entries(value));
}

function errorCode(body: unknown): string {
  return String(asRecord(asRecord(body).error).code);
}

function fingerprint(db: AuthorityDb): string {
  return JSON.stringify({
    requests: db.db.prepare("SELECT request_id,state,lease_fence,completed_at,failure_code FROM control_command_requests ORDER BY request_id").all(),
    counts: db.db.prepare("SELECT (SELECT COUNT(*) FROM control_command_receipts) AS receipts, (SELECT COUNT(*) FROM control_command_redemptions) AS redemptions, (SELECT COUNT(*) FROM control_command_effects) AS effects, (SELECT COUNT(*) FROM control_command_revocations) AS revocations, (SELECT COUNT(*) FROM workflow_runs) AS runs, (SELECT COUNT(*) FROM workflow_steps) AS steps, (SELECT COUNT(*) FROM workflow_transitions) AS transitions, (SELECT COUNT(*) FROM live_supervisor_bindings) AS bindings").get(),
  });
}

function assertSanitized(value: unknown, secrets: readonly string[]): void {
  const text = JSON.stringify(value);
  for (const secret of secrets) expect(text).not.toContain(secret);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (typeof node !== "object" || node === null) return;
    for (const [key, child] of Object.entries(node)) {
      if (SECRET_KEY_PATTERN.test(key)) expect(child).toBe("[REDACTED]");
      walk(child);
    }
  };
  walk(value);
}

function startCommand(taskId: string, requestedAt: string): ControlCommandRequestInput {
  const target = { environment: "local", run_id: `run:${taskId}`, loop_id: "agentops-default", correlation_id: taskId, task_id: taskId };
  const args = { run_id: target.run_id, loop_id: target.loop_id, correlation_id: taskId, input: { task_id: taskId, objective: `Inspect ${taskId}` }, budget: { max_steps: 8, max_attempts_per_node: 2, deadline: future(30) } };
  return { schema_version: 1, request_id: `request:${taskId}`, action: "workflow.start", action_level: 2, target, args, reversible: true, requested_by: "test-operator", requested_at: requestedAt, expires_at: future(10), nonce: `nonce:${taskId}` };
}

function seedTasks(db: AuthorityDb): void {
  const control = new ControlPlane(db);
  control.stage(startCommand("task:alpha", "2026-08-18T00:00:00.000Z"));
  control.stage(startCommand("task:beta", "2026-08-18T00:01:00.000Z"));
}

function seedAgents(db: AuthorityDb): readonly { readonly agent_id: string; readonly terminal_id: string }[] {
  const root = track(mkdtempSync(join(tmpdir(), "jarvis-dashboard-agents-")));
  const supervisor = new LiveSupervisor(db);
  return ([
    { dir: "a-work", provider: "claude" as const, terminal_id: "term-a", session_id: "session-secret-alpha", incarnation_id: "inc-a", project_id: "project-a", at: "2026-08-18T00:00:00.000Z" },
    { dir: "z-work", provider: "codex" as const, terminal_id: "term-z", session_id: "session-secret-zeta", incarnation_id: "inc-z", project_id: "project-z", at: "2026-08-18T00:00:01.000Z" },
  ]).map((input) => {
    const worktree = join(root, input.dir);
    mkdirSync(worktree);
    const binding = supervisor.register({ worktree, provider: input.provider, terminal_id: input.terminal_id, session_id: input.session_id, incarnation_id: input.incarnation_id, project_id: input.project_id }, input.at);
    return { agent_id: `sha256:${createHash("sha256").update(canonicalize({ canonical_path: binding.canonical_path, provider: binding.provider, terminal_id: binding.terminal_id, incarnation_id: binding.incarnation_id })).digest("hex")}`, terminal_id: binding.terminal_id };
  });
}

async function getJson(server: DashboardServer, path: string): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await request(`${originOf(server)}${path}`);
  return { status: response.statusCode, body: parseJson(await response.body.text()) };
}

describe("dashboard task, agent, and control reads", () => {
  it("lists tasks with schema_version 1, deterministic order, and a bounded limit", async () => {
    const db = await migratedDb();
    seedTasks(db);
    const server = startServer(db);
    const before = fingerprint(db);
    try {
      const listed = await getJson(server, "/api/v1/tasks?limit=500");
      expect(listed.status).toBe(200);
      const body = asRecord(listed.body);
      expect(body.schema_version).toBe(1);
      expect(Array.isArray(body.items)).toBe(true);
      const items = Array.isArray(body.items) ? body.items.map(asRecord) : [];
      expect(items.map((item) => item.task_id)).toEqual(["task:beta", "task:alpha"]);
      const bounded = await getJson(server, "/api/v1/tasks?limit=1");
      expect(asRecord(bounded.body).items).toEqual([items[0]]);
      expect(fingerprint(db)).toBe(before);
    } finally {
      server.close();
      db.close();
    }
  });

  it("rejects a task limit outside 1..500 with a typed 400", async () => {
    const db = await migratedDb();
    const server = startServer(db);
    try {
      for (const limit of ["0", "501"]) {
        const response = await getJson(server, `/api/v1/tasks?limit=${limit}`);
        expect(response.status).toBe(400);
        expect(asRecord(response.body).schema_version).toBe(1);
        expect(errorCode(response.body)).toBe("VALIDATION_ERROR");
      }
    } finally {
      server.close();
      db.close();
    }
  });

  it("returns sanitized task detail and a typed 404 for an unknown task", async () => {
    const db = await initialized();
    track(dirname(db.filename));
    const control = new ControlPlane(db);
    const staged = control.stage(startCommand("task:alpha", "2026-08-18T00:00:00.000Z"));
    const issuedAt = new Date().toISOString();
    const receipt = signCommandApproval({
      schema_version: 1, receipt_id: "approval:task:alpha", request_id: staged.request_id, decision: "approve",
      command_digest: staged.command_digest, signer_principal_id: "test-operator",
      authenticated_session_id: "session-secret-alpha", key_id: "decision-test", algorithm: "Ed25519",
      issued_at: issuedAt, not_before: issuedAt, expires_at: staged.expires_at, nonce: "receipt:task:alpha",
      max_uses: 1, status: "issued",
    }, localKey(db));
    control.decide(receipt);
    const server = startServer(db);
    const before = fingerprint(db);
    try {
      const found = await getJson(server, `/api/v1/tasks/${encodeURIComponent("task:alpha")}`);
      expect(found.status).toBe(200);
      const body = asRecord(found.body);
      expect(body.schema_version).toBe(1);
      const context = asRecord(body.context);
      expect(asRecord(context.task).task_id).toBe("task:alpha");
      expect(Array.isArray(context.events)).toBe(true);
      if (Array.isArray(context.events)) expect(context.events.length).toBeLessThanOrEqual(500);
      assertSanitized(found.body, [receipt.signature, receipt.authenticated_session_id]);
      const missing = await getJson(server, "/api/v1/tasks/task-missing");
      expect(missing.status).toBe(404);
      expect(errorCode(missing.body)).toBe("TASK_NOT_FOUND");
      expect(fingerprint(db)).toBe(before);
    } finally {
      server.close();
      db.close();
    }
  });

  it("lists agents in deterministic identity order and 404s an unknown agent", async () => {
    const db = await migratedDb();
    const seeded = seedAgents(db);
    const server = startServer(db);
    const before = fingerprint(db);
    try {
      const listed = await getJson(server, "/api/v1/agents");
      expect(listed.status).toBe(200);
      const body = asRecord(listed.body);
      expect(body.schema_version).toBe(1);
      const items = Array.isArray(body.items) ? body.items.map(asRecord) : [];
      expect(items.map((item) => item.agent_id)).toEqual(seeded.map((item) => item.agent_id));
      expect(items.map((item) => item.terminal_id)).toEqual(["term-a", "term-z"]);
      const detail = await getJson(server, `/api/v1/agents/${encodeURIComponent(seeded[0]?.agent_id ?? "")}`);
      expect(detail.status).toBe(200);
      expect(asRecord(asRecord(detail.body).agent).agent_id).toBe(seeded[0]?.agent_id);
      assertSanitized(listed.body, ["session-secret-alpha", "session-secret-zeta"]);
      assertSanitized(detail.body, ["session-secret-alpha", "session-secret-zeta"]);
      const missing = await getJson(server, "/api/v1/agents/sha256:missing");
      expect(missing.status).toBe(404);
      expect(errorCode(missing.body)).toBe("AGENT_NOT_FOUND");
      expect(fingerprint(db)).toBe(before);
    } finally {
      server.close();
      db.close();
    }
  });

  it("lists control requests by requested_at,request_id without leaking receipt material", async () => {
    const db = await initialized();
    track(dirname(db.filename));
    seedTasks(db);
    const server = startServer(db);
    const before = fingerprint(db);
    try {
      const listed = await getJson(server, "/api/v1/control/requests");
      expect(listed.status).toBe(200);
      const body = asRecord(listed.body);
      expect(body.schema_version).toBe(1);
      const items = Array.isArray(body.items) ? body.items.map(asRecord) : [];
      expect(items.map((item) => item.request_id)).toEqual(["request:task:alpha", "request:task:beta"]);
      assertSanitized(listed.body, ["session-secret-alpha"]);
      expect(fingerprint(db)).toBe(before);
    } finally {
      server.close();
      db.close();
    }
  });
});
