import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import { AuthorityDb, JarvisError, LiveSupervisor, canonicalize, type OrcaRunner } from "../../src/index.js";
import { redactTerminalLine } from "../../src/dashboard/redaction.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { tempDb } from "../helpers.js";

const SESSION_SECRET = "session-secret-alpha";
const SAFE_LINE = "safe compile finished in 12.4s";
const SECRET_LINES = [
  "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.token.sig",
  "export OPENAI_API_KEY=sk-proj-1234567890",
  "AWS_ACCESS_KEY_ID=AKIA12345678 AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI",
  "-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END PRIVATE KEY-----",
  "JAWS_API_KEY=supersecretvalue",
] as const;

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

function envelope(result: Record<string, unknown>, ok = true): string {
  return JSON.stringify({ id: "orca-response", ok, result, _meta: {} });
}

function orcaTerminal(): Record<string, unknown> {
  return {
    handle: "term-1", tabId: "tab", leafId: "leaf", ptyId: "pty-1", incarnationId: "inc-1",
    worktreeId: "worktree-1", worktreePath: "/repo", title: "Codex session", connected: true,
    writable: true, lastOutputAt: 1_723_215_678_901, preview: null,
  };
}

function readEnvelope(lines: readonly string[]): string {
  return envelope({
    terminal: {
      handle: "term-1", status: "running", tail: [...lines], truncated: false, limited: false,
      oldestCursor: null, nextCursor: "cursor-1", latestCursor: "cursor-1", returnedLineCount: lines.length,
    },
  });
}

function startServer(db: AuthorityDb, orcaRunner: OrcaRunner): DashboardServer {
  const root = track(mkdtempSync(join(tmpdir(), "jarvis-dashboard-term-")));
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
  const injected = { orcaRunner };
  return createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0, ...injected });
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
    bindings: db.db.prepare("SELECT canonical_path,provider,terminal_id,session_id,incarnation_id FROM live_supervisor_bindings ORDER BY canonical_path,provider,terminal_id").all(),
    counts: db.db.prepare(`SELECT
      (SELECT COUNT(*) FROM control_command_requests) AS requests,
      (SELECT COUNT(*) FROM control_command_receipts) AS receipts,
      (SELECT COUNT(*) FROM control_command_redemptions) AS redemptions,
      (SELECT COUNT(*) FROM control_command_effects) AS effects
    `).get(),
  });
}

function agentId(binding: { readonly canonical_path: string; readonly provider: string; readonly terminal_id: string; readonly incarnation_id: string }): string {
  return `sha256:${createHash("sha256").update(canonicalize({
    canonical_path: binding.canonical_path,
    provider: binding.provider,
    terminal_id: binding.terminal_id,
    incarnation_id: binding.incarnation_id,
  })).digest("hex")}`;
}

function seedBinding(db: AuthorityDb): { readonly agent_id: string } {
  const worktree = join(track(mkdtempSync(join(tmpdir(), "jarvis-term-bind-"))), "worktree");
  mkdirSync(worktree);
  const binding = new LiveSupervisor(db).register({
    worktree, provider: "codex", terminal_id: "term-1", session_id: SESSION_SECRET,
    incarnation_id: "inc-1", pty_id: "pty-1", worktree_id: "worktree-1", project_id: "dashboard-project",
  }, "2026-08-18T00:00:00.000Z");
  return { agent_id: agentId(binding) };
}

function recordingRunner(input: {
  readonly calls: string[][];
  readonly list: readonly Record<string, unknown>[];
  readonly lines?: readonly string[];
  readonly fail?: boolean;
}): OrcaRunner {
  return async (args) => {
    input.calls.push([...args]);
    if (args[0] === "terminal" && args[1] === "send") throw new Error("terminal send is forbidden");
    if (input.fail) throw new JarvisError("ORCA_CLI_FAILED");
    if (args[1] === "list") return envelope({ terminals: [...input.list] });
    if (args[1] === "read") return readEnvelope(input.lines ?? [SAFE_LINE]);
    throw new JarvisError("ORCA_CLI_FAILED");
  };
}

function neverSent(calls: readonly (readonly string[])[]): void {
  expect(calls.some((args) => args[0] === "terminal" && args[1] === "send")).toBe(false);
}

async function getLogs(server: DashboardServer, agent: string, limit = 500): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await request(`${originOf(server)}/api/v1/agents/${encodeURIComponent(agent)}/logs?limit=${String(limit)}`);
  return { status: response.statusCode, body: parseJson(await response.body.text()) };
}

describe("dashboard redacted terminal logs", () => {
  it("returns at most 500 redacted lines for an exact binding and never sends", async () => {
    const db = await migratedDb();
    const seeded = seedBinding(db);
    const lines = [SAFE_LINE, ...SECRET_LINES];
    const calls: string[][] = [];
    const server = startServer(db, recordingRunner({ calls, list: [orcaTerminal()], lines }));
    const before = fingerprint(db);
    try {
      const response = await getLogs(server, seeded.agent_id, 500);
      expect(response.status).toBe(200);
      const body = asRecord(response.body);
      expect(body.schema_version).toBe(1);
      expect(body.agent_id).toBe(seeded.agent_id);
      expect(Array.isArray(body.lines)).toBe(true);
      const returned = Array.isArray(body.lines) ? body.lines : [];
      expect(returned.length).toBeLessThanOrEqual(500);
      expect(returned).toEqual(lines.map(redactTerminalLine));
      expect(returned).toContain(SAFE_LINE);
      expect(returned.filter((line) => line === "[REDACTED]")).toHaveLength(SECRET_LINES.length);
      expect(JSON.stringify(body)).not.toContain(SESSION_SECRET);
      expect(JSON.stringify(body)).not.toContain("sk-proj-1234567890");
      neverSent(calls);
      expect(fingerprint(db)).toBe(before);
    } finally {
      server.close();
      db.close();
    }
  });

  it("returns a typed 404 for missing or ambiguous bindings and never sends", async () => {
    const db = await migratedDb();
    const seeded = seedBinding(db);
    const calls: string[][] = [];
    const server = startServer(db, recordingRunner({
      calls,
      list: [orcaTerminal(), { ...orcaTerminal(), tabId: "other", leafId: "other" }],
    }));
    const before = fingerprint(db);
    try {
      const missing = await getLogs(server, "sha256:missing");
      expect(missing.status).toBe(404);
      expect(errorCode(missing.body)).toBe("AGENT_NOT_FOUND");
      const ambiguous = await getLogs(server, seeded.agent_id);
      expect(ambiguous.status).toBe(404);
      expect(errorCode(ambiguous.body)).toBe("AGENT_NOT_FOUND");
      neverSent(calls);
      expect(fingerprint(db)).toBe(before);
    } finally {
      server.close();
      db.close();
    }
  });

  it("maps an Orca failure to typed 502 and never sends", async () => {
    const db = await migratedDb();
    const seeded = seedBinding(db);
    const calls: string[][] = [];
    const server = startServer(db, recordingRunner({ calls, list: [orcaTerminal()], fail: true }));
    const before = fingerprint(db);
    try {
      const response = await getLogs(server, seeded.agent_id);
      expect(response.status).toBe(502);
      expect(errorCode(response.body)).toBe("ORCA_UNAVAILABLE");
      neverSent(calls);
      expect(JSON.stringify(response.body)).not.toContain(SESSION_SECRET);
      expect(fingerprint(db)).toBe(before);
    } finally {
      server.close();
      db.close();
    }
  });

  it("rejects a log limit outside 1..500 before calling Orca", async () => {
    const db = await migratedDb();
    const seeded = seedBinding(db);
    const calls: string[][] = [];
    const server = startServer(db, recordingRunner({ calls, list: [orcaTerminal()] }));
    try {
      for (const limit of [0, 501]) {
        const response = await getLogs(server, seeded.agent_id, limit);
        expect(response.status).toBe(400);
        expect(errorCode(response.body)).toBe("VALIDATION_ERROR");
      }
      expect(calls).toEqual([]);
    } finally {
      server.close();
      db.close();
    }
  });
});
