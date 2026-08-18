import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import {
  AuthorityDb,
  buildCapabilityMatrix,
  planTeamProposal,
  type CapabilityFact,
  type CapabilityProbe,
  type TeamProposalRequestV1,
} from "../../src/index.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { tempDb } from "../helpers.js";

const PREVIEW_PATH = "/api/v1/proposals/preview";
const CSRF_HEADER = "X-JARVIS-CSRF";
const JSON_TYPE = "application/json";
const NOW = new Date("2026-08-18T12:00:00.000Z");
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

type Observation = Awaited<ReturnType<CapabilityProbe["inspect"]>>;
type DashboardPlannerSeam = {
  readonly capabilityProbe: CapabilityProbe;
  readonly planner: typeof planTeamProposal;
};

const healthyObservation = (): Observation => ({
  installed: { ok: true, version: "0.11.8", evidence: "executable_present" },
  configured: { ok: true, evidence: "configuration_present" },
  protocol_compatible: { ok: true, protocol_version: "2024-11-05", evidence: "protocol_compatible" },
  operational: { ok: true, evidence: "runtime_healthy" },
  authorized: { ok: true, evidence: "authority_present" },
});

function capabilityProbe(overrides: Partial<Record<CapabilityFact["id"], Observation>> = {}): CapabilityProbe {
  const fixtures: Record<CapabilityFact["id"], Observation> = {
    codex: healthyObservation(),
    claude: healthyObservation(),
    orca_read: { ...healthyObservation(), installed: { ok: true, version: null, evidence: "adapter_present" } },
    gjc: healthyObservation(),
    live_resume: healthyObservation(),
    ...overrides,
  };
  return { inspect: async (id) => fixtures[id] ?? healthyObservation() };
}

function readyRequest(): TeamProposalRequestV1 {
  return {
    schema_version: 1,
    objective: "Ship a bounded capability-aware planner",
    work_type: "development",
    completion_evidence: ["passing focused vitest", "tsc --noEmit exit 0"],
    answers: [],
    constraints: ["no persistence"],
    requested_capabilities: ["codex"],
  };
}

function startServer(db: AuthorityDb, seam: DashboardPlannerSeam): DashboardServer {
  const root = track(mkdtempSync(join(tmpdir(), "jarvis-dashboard-proposal-")));
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
  const options = { db, staticRoot: root, host: "127.0.0.1", port: 0, ...seam };
  return createDashboardServer(options);
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

function totalChanges(db: AuthorityDb): number {
  const count = db.db.prepare("SELECT total_changes() AS count").pluck().get();
  if (typeof count !== "number") throw new Error("total_changes");
  return count;
}

function authorityFingerprint(db: AuthorityDb): string {
  return JSON.stringify({
    total_changes: totalChanges(db),
    requests: db.db.prepare("SELECT request_id,state,lease_fence,completed_at,failure_code FROM control_command_requests ORDER BY request_id").all(),
    counts: db.db.prepare(`SELECT
      (SELECT COUNT(*) FROM control_command_receipts) AS receipts,
      (SELECT COUNT(*) FROM control_command_redemptions) AS redemptions,
      (SELECT COUNT(*) FROM control_command_effects) AS effects,
      (SELECT COUNT(*) FROM control_command_revocations) AS revocations,
      (SELECT COUNT(*) FROM workflow_runs) AS runs,
      (SELECT COUNT(*) FROM workflow_steps) AS steps,
      (SELECT COUNT(*) FROM workflow_transitions) AS transitions
    `).get(),
  });
}

function errorCode(body: unknown): string {
  return String(asRecord(asRecord(body).error).code);
}

async function csrfToken(server: DashboardServer): Promise<string> {
  const response = await request(`${originOf(server)}/api/v1/session`);
  const token = asRecord(parseJson(await response.body.text())).csrf_token;
  if (response.statusCode !== 200 || typeof token !== "string" || token.length < 32) throw new Error("session csrf required");
  return token;
}

async function postPreview(
  server: DashboardServer,
  init: { readonly csrf?: string; readonly contentType?: string; readonly body: string },
): Promise<{ readonly status: number; readonly body: unknown; readonly requestId: string }> {
  const headers: Record<string, string> = {};
  if (init.contentType !== undefined) headers["content-type"] = init.contentType;
  if (init.csrf !== undefined) headers[CSRF_HEADER] = init.csrf;
  const response = await request(`${originOf(server)}${PREVIEW_PATH}`, { method: "POST", headers, body: init.body });
  return {
    status: response.statusCode,
    body: parseJson(await response.body.text()),
    requestId: String(response.headers["x-request-id"] ?? ""),
  };
}

describe("dashboard team proposal preview", () => {
  it("returns ready, blocked, and needs_input from planTeamProposal without persistence", async () => {
    const blockedProbe = capabilityProbe({
      codex: { ...healthyObservation(), operational: { ok: false, evidence: "runtime_unverified" } },
    });
    const cases = [
      { probe: capabilityProbe(), request: readyRequest() },
      { probe: blockedProbe, request: readyRequest() },
      { probe: capabilityProbe(), request: { schema_version: 1 as const, objective: "Clarify the missing planning inputs" } },
    ];
    for (const fixture of cases) {
      const db = await migratedDb();
      const seam = { capabilityProbe: fixture.probe, planner: planTeamProposal };
      const server = startServer(db, seam);
      const before = authorityFingerprint(db);
      try {
        const expected = planTeamProposal(fixture.request, await buildCapabilityMatrix(db, fixture.probe, NOW));
        const posted = await postPreview(server, {
          csrf: await csrfToken(server),
          contentType: JSON_TYPE,
          body: JSON.stringify(fixture.request),
        });
        expect(posted.status).toBe(200);
        expect(posted.requestId.length).toBeGreaterThan(0);
        expect(posted.body).toEqual({ schema_version: 1, proposal: expected });
        expect(asRecord(asRecord(posted.body).proposal).status).toBe(expected.status);
        expect(authorityFingerprint(db)).toBe(before);
      } finally {
        server.close();
        db.close();
      }
    }
  });

  it("rejects malformed bodies and unknown keys with typed 400 and zero writes", async () => {
    const db = await migratedDb();
    const probe = capabilityProbe();
    const server = startServer(db, { capabilityProbe: probe, planner: planTeamProposal });
    const before = authorityFingerprint(db);
    const csrf = await csrfToken(server);
    try {
      for (const body of [
        { schema_version: 1, objective: "valid objective", extra: true },
        { schema_version: 2, objective: "valid objective" },
        { schema_version: 1, objective: "   " },
        { schema_version: 1, objective: "valid objective", work_type: "operations" },
      ]) {
        const posted = await postPreview(server, { csrf, contentType: JSON_TYPE, body: JSON.stringify(body) });
        expect(posted.status).toBe(400);
        expect(asRecord(posted.body).schema_version).toBe(1);
        expect(errorCode(posted.body)).toBe("TEAM_PROPOSAL_INPUT_INVALID");
        expect(authorityFingerprint(db)).toBe(before);
      }
    } finally {
      server.close();
      db.close();
    }
  });

  it("rejects missing and invalid CSRF with 403 and an identical fingerprint", async () => {
    const db = await migratedDb();
    const server = startServer(db, { capabilityProbe: capabilityProbe(), planner: planTeamProposal });
    const before = authorityFingerprint(db);
    const body = JSON.stringify(readyRequest());
    try {
      const missing = await postPreview(server, { contentType: JSON_TYPE, body });
      const invalid = await postPreview(server, { csrf: "a".repeat(32), contentType: JSON_TYPE, body });
      for (const posted of [missing, invalid]) {
        expect(posted.status).toBe(403);
        expect(asRecord(posted.body).schema_version).toBe(1);
        expect(errorCode(posted.body)).toBe("LOCAL_SESSION_REQUIRED");
      }
      expect(authorityFingerprint(db)).toBe(before);
    } finally {
      server.close();
      db.close();
    }
  });

  it("rejects a non-JSON content type with 415 and does not persist", async () => {
    const db = await migratedDb();
    const server = startServer(db, { capabilityProbe: capabilityProbe(), planner: planTeamProposal });
    const before = authorityFingerprint(db);
    try {
      const posted = await postPreview(server, {
        csrf: await csrfToken(server),
        contentType: "text/plain",
        body: JSON.stringify(readyRequest()),
      });
      expect(posted.status).toBe(415);
      expect(asRecord(posted.body).schema_version).toBe(1);
      expect(errorCode(posted.body)).toBe("UNSUPPORTED_MEDIA_TYPE");
      expect(authorityFingerprint(db)).toBe(before);
    } finally {
      server.close();
      db.close();
    }
  });
});
