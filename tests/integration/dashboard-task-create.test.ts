import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import {
  AuthorityDb, ControlPlane, buildCapabilityMatrix, planTeamProposal,
  type CapabilityFact, type CapabilityProbe, type TeamProposalRequestV1,
} from "../../src/index.js";
import type { CreateTaskRequest, Sha256Digest } from "../../src/dashboard/contracts.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { tempDb } from "../helpers.js";

const TASKS = "/api/v1/tasks";
const CSRF = "X-JARVIS-CSRF";
const JSON_TYPE = "application/json";
const LIMIT = 64 * 1024;
const NOW = new Date("2026-08-18T12:00:00.000Z");
const DEADLINE = "2026-08-18T18:00:00.000Z";
const STALE = `sha256:${"b".repeat(64)}` as const;
const CODE_400 = new Set(["VALIDATION_ERROR", "TASK_INPUT_INVALID", "CONTROL_COMMAND_INVALID", "TEAM_PROPOSAL_INPUT_INVALID"]);
const NON_READY = new Set(["VALIDATION_ERROR", "CONTROL_STATE_CONFLICT", "TEAM_PROPOSAL_INPUT_INVALID", "CONTROL_COMMAND_INVALID"]);
const dirs = new Set<string>();
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

async function migratedDb(): Promise<AuthorityDb> {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  dirs.add(dirname(db.filename));
  return db;
}

type Observation = Awaited<ReturnType<CapabilityProbe["inspect"]>>;
type Seam = { readonly capabilityProbe: CapabilityProbe; readonly planner: typeof planTeamProposal; readonly clock: () => Date };

function observation(operational = true): Observation {
  return {
    installed: { ok: true, version: "0.11.8", evidence: "executable_present" },
    configured: { ok: true, evidence: "configuration_present" },
    protocol_compatible: { ok: true, protocol_version: "2024-11-05", evidence: "protocol_compatible" },
    operational: { ok: operational, evidence: operational ? "runtime_healthy" : "runtime_unverified" },
    authorized: { ok: true, evidence: "authority_present" },
  };
}

function probe(operational = true): CapabilityProbe {
  const healthy = observation(true);
  const fixtures: Record<CapabilityFact["id"], Observation> = {
    codex: observation(operational), claude: healthy, gjc: healthy, live_resume: healthy,
    orca_read: { ...healthy, installed: { ok: true, version: null, evidence: "adapter_present" } },
  };
  return { inspect: async (id) => fixtures[id] ?? healthy };
}

function proposal(complete = true): TeamProposalRequestV1 {
  if (!complete) return { schema_version: 1, objective: "Need a work type before staging" };
  return {
    schema_version: 1, objective: "Ship a bounded capability-aware planner", work_type: "development",
    completion_evidence: ["passing focused vitest"], answers: [], constraints: ["no persistence"],
    requested_capabilities: ["codex"],
  };
}

function digestOf(value: string): Sha256Digest {
  const match = /^sha256:([0-9a-f]{64})$/.exec(value);
  if (match?.[1] === undefined) throw new Error("proposal digest");
  return `sha256:${match[1]}`;
}

function taskBody(digest: Sha256Digest, request = proposal()): CreateTaskRequest {
  return {
    schema_version: 1, request_id: "req-task-create-1", nonce: "nonce-task-create-1",
    task_id: "task-create-1", run_id: "run-create-1", expected_proposal_digest: digest,
    proposal_request: request, budget: { max_steps: 10, max_attempts_per_node: 3, deadline: DEADLINE },
  };
}

function startServer(db: AuthorityDb, capabilityProbe: CapabilityProbe): DashboardServer {
  const root = mkdtempSync(join(tmpdir(), "jarvis-dashboard-task-create-"));
  dirs.add(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
  const seam: Seam = { capabilityProbe, planner: planTeamProposal, clock: () => NOW };
  return createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0, ...seam });
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
function fingerprint(db: AuthorityDb): string {
  return JSON.stringify({
    requests: db.db.prepare("SELECT request_id,state,lease_fence,completed_at,failure_code FROM control_command_requests ORDER BY request_id").all(),
    counts: db.db.prepare("SELECT (SELECT COUNT(*) FROM control_command_receipts) AS receipts, (SELECT COUNT(*) FROM control_command_redemptions) AS redemptions, (SELECT COUNT(*) FROM control_command_effects) AS effects, (SELECT COUNT(*) FROM control_command_revocations) AS revocations, (SELECT COUNT(*) FROM workflow_runs) AS runs, (SELECT COUNT(*) FROM workflow_steps) AS steps, (SELECT COUNT(*) FROM workflow_transitions) AS transitions").get(),
  });
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
  init: { readonly csrf?: string; readonly type?: string; readonly body: string },
): Promise<{ readonly status: number; readonly body: unknown }> {
  const headers: Record<string, string> = { origin: origin(server) };
  if (init.type !== undefined) headers["content-type"] = init.type;
  if (init.csrf !== undefined) headers[CSRF] = init.csrf;
  const response = await request(`${origin(server)}${path}`, { method: "POST", headers, body: init.body });
  return { status: response.statusCode, body: parseJson(await response.body.text()) };
}

async function readyDigest(db: AuthorityDb, capabilityProbe: CapabilityProbe): Promise<Sha256Digest> {
  const planned = planTeamProposal(proposal(), await buildCapabilityMatrix(db, capabilityProbe, NOW));
  if (planned.status !== "ready") throw new Error("ready proposal required");
  return digestOf(planned.proposal_digest);
}

describe("dashboard receipt-bound task request staging", () => {
  it("stages exactly one pending workflow.start for a matching ready digest", async () => {
    const db = await migratedDb();
    const capabilityProbe = probe();
    const server = startServer(db, capabilityProbe);
    const requestBody = proposal();
    const digest = await readyDigest(db, capabilityProbe);
    const input = taskBody(digest, requestBody);
    const planned = planTeamProposal(requestBody, await buildCapabilityMatrix(db, capabilityProbe, NOW));
    if (planned.status !== "ready") throw new Error("ready proposal required");
    try {
      const posted = await post(server, TASKS, { csrf: await csrfToken(server), type: JSON_TYPE, body: JSON.stringify(input) });
      expect(posted.status).toBe(202);
      expect(asRecord(posted.body).schema_version).toBe(1);
      expect(asRecord(asRecord(posted.body).request)).toMatchObject({
        action: "workflow.start", action_level: 2, state: "pending", reversible: true,
        requested_by: "jarvis-control-center", request_id: input.request_id,
        target: { environment: "local", run_id: input.run_id, loop_id: "agentops-default", correlation_id: input.task_id, task_id: input.task_id },
      });
      expect(JSON.stringify(posted.body)).not.toMatch(/private_key|BEGIN [A-Z ]*PRIVATE KEY|csrf_token/i);
      const staged = new ControlPlane(db).list();
      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatchObject({
        action: "workflow.start", action_level: 2, state: "pending", requested_by: "jarvis-control-center",
        request_id: input.request_id, nonce: input.nonce,
        args: {
          run_id: input.run_id, loop_id: "agentops-default", correlation_id: input.task_id, budget: input.budget,
          input: { task_id: input.task_id, objective: requestBody.objective, proposal_digest: digest, members: planned.members },
        },
      });
      expect(parseJson(fingerprint(db))).toMatchObject({
        counts: { receipts: 0, redemptions: 0, effects: 0, revocations: 0, runs: 0, steps: 0, transitions: 0 },
      });
    } finally {
      server.close();
      db.close();
    }
  });

  it("rejects stale, blocked, and needs_input proposals with typed 400/409 and identical fingerprints", async () => {
    const cases = [
      { probe: probe(), request: proposal(), digest: STALE, status: [409], codes: new Set(["PROPOSAL_STALE"]) },
      { probe: probe(false), request: proposal(), digest: STALE, status: [400, 409], codes: NON_READY },
      { probe: probe(), request: proposal(false), digest: STALE, status: [400, 409], codes: NON_READY },
    ];
    for (const fixture of cases) {
      const db = await migratedDb();
      const server = startServer(db, fixture.probe);
      const before = fingerprint(db);
      try {
        const posted = await post(server, TASKS, {
          csrf: await csrfToken(server), type: JSON_TYPE, body: JSON.stringify(taskBody(fixture.digest, fixture.request)),
        });
        expect(fixture.status).toContain(posted.status);
        expect(fixture.codes.has(errorCode(posted.body))).toBe(true);
        expect(fingerprint(db)).toBe(before);
      } finally {
        server.close();
        db.close();
      }
    }
  });

  it("rejects malformed budget, deadline, and ids with typed 400 and zero writes", async () => {
    const db = await migratedDb();
    const capabilityProbe = probe();
    const server = startServer(db, capabilityProbe);
    const valid = taskBody(await readyDigest(db, capabilityProbe));
    const before = fingerprint(db);
    const csrf = await csrfToken(server);
    try {
      for (const body of [
        { ...valid, extra: true }, { ...valid, request_id: "x".repeat(129) }, { ...valid, task_id: "   " },
        { ...valid, budget: { ...valid.budget, max_steps: 0 } },
        { ...valid, budget: { ...valid.budget, max_attempts_per_node: 11 } },
        { ...valid, budget: { ...valid.budget, deadline: "2026-08-18T18:00:00Z" } },
        { ...valid, budget: { ...valid.budget, deadline: NOW.toISOString() } },
        { ...valid, budget: { ...valid.budget, deadline: "2026-08-20T12:00:00.000Z" } },
      ]) {
        const posted = await post(server, TASKS, { csrf, type: JSON_TYPE, body: JSON.stringify(body) });
        expect(posted.status).toBe(400);
        expect(CODE_400.has(errorCode(posted.body))).toBe(true);
        expect(fingerprint(db)).toBe(before);
      }
    } finally {
      server.close();
      db.close();
    }
  });

  it("rejects missing CSRF, oversized bodies, malformed JSON, and unknown POST actions with zero writes", async () => {
    const db = await migratedDb();
    const capabilityProbe = probe();
    const server = startServer(db, capabilityProbe);
    const body = JSON.stringify(taskBody(await readyDigest(db, capabilityProbe)));
    const csrf = await csrfToken(server);
    const before = fingerprint(db);
    try {
      const missing = await post(server, TASKS, { type: JSON_TYPE, body });
      expect(missing.status).toBe(403);
      expect(errorCode(missing.body)).toBe("LOCAL_SESSION_REQUIRED");
      const invalid = await post(server, TASKS, { csrf: "a".repeat(32), type: JSON_TYPE, body });
      expect(invalid.status).toBe(403);
      expect(errorCode(invalid.body)).toBe("LOCAL_SESSION_REQUIRED");
      const oversized = await post(server, TASKS, { csrf, type: JSON_TYPE, body: `{"pad":"${"x".repeat(LIMIT)}"}` });
      expect(oversized.status).toBe(413);
      expect(errorCode(oversized.body)).toBe("BODY_TOO_LARGE");
      const malformed = await post(server, TASKS, { csrf, type: JSON_TYPE, body: "{" });
      expect(malformed.status).toBe(400);
      expect(errorCode(malformed.body)).toBe("JSON_INVALID");
      const unknown = await post(server, "/api/v1/no-such-action", { csrf, type: JSON_TYPE, body: JSON.stringify({ schema_version: 1 }) });
      expect([400, 404]).toContain(unknown.status);
      expect(["NOT_FOUND", "VALIDATION_ERROR"]).toContain(errorCode(unknown.body));
      expect(fingerprint(db)).toBe(before);
    } finally {
      server.close();
      db.close();
    }
  });
});
