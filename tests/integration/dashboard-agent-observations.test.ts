import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { request } from "undici";
import { AuthorityDb, JarvisError } from "../../src/db.js";
import { LiveSupervisor } from "../../src/live-supervisor.js";
import { observeBound } from "../../src/cli-live-commands.js";
import { listedAgents, AGENT_OBSERVATION_TTL_MS } from "../../src/dashboard/agent-read-model.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { tempDb } from "../helpers.js";

const at = new Date("2026-09-08T00:00:00.000Z");
async function fixture() {
  const db = new AuthorityDb(tempDb()); await db.migrate();
  const root = mkdtempSync(join(tmpdir(), "agent-observations-"));
  const supervisor = new LiveSupervisor(db);
  const binding = supervisor.register({ worktree: root, provider: "codex", terminal_id: "terminal",
    session_id: "private-session", incarnation_id: "incarnation", pty_id: "pty", worktree_id: "worktree" }, at.toISOString());
  return { db, root, supervisor, binding, close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe("agent connection observations", () => {
  it("recovers an existing v2 report byte-for-byte before collecting v3 observations", async () => {
    const f = await fixture();
    try {
      const report = { report_id: `live_report_${"a".repeat(64)}`, payload_json: '{"version":2,"changes":[],"sources":[]}',
        payload_digest: `sha256:${"b".repeat(64)}` };
      f.db.db.prepare(`INSERT INTO live_supervisor_reports(report_id,canonical_path,payload_json,payload_digest,created_at)
        VALUES(?,?,?,?,?)`).run(report.report_id, "*", report.payload_json, report.payload_digest, at.toISOString());
      const recovered = await f.supervisor.cycleAll(() => { throw new Error("must recover before probing"); }, at.toISOString());
      expect(recovered.recovered_report).toEqual(report);
      expect(listedAgents(f.db, at)[0]?.status).toBe("unknown");
      f.supervisor.acknowledgeReport(report.report_id, at.toISOString());
      const next = await f.supervisor.cycleAll(binding => [{ ...binding, state: "unknown", connected: true }], at.toISOString());
      expect(JSON.parse(next.report!.payload_json)).toMatchObject({ version: 3, previous_report_id: report.report_id });
      expect(listedAgents(f.db, at)[0]?.status).toBe("live");
    } finally { f.close(); }
  });

  it("does not promote registration or legacy progress into a live connection", async () => {
    const f = await fixture();
    try {
      expect(listedAgents(f.db, at)[0]).toMatchObject({ status: "unknown", observed_at: null });
      await f.supervisor.cycleAll(binding => [{ ...binding, state: "running" }], at.toISOString());
      expect(listedAgents(f.db, at)[0]).toMatchObject({ status: "unknown", observed_at: null });
    } finally { f.close(); }
  });

  it("keeps connection freshness independent of progress and preserves it across restart", async () => {
    const f = await fixture();
    try {
      const cycle = await f.supervisor.cycleAll(binding => [{ ...binding, state: "unknown", connected: true }], at.toISOString());
      expect(listedAgents(f.db, at)[0]).toMatchObject({ status: "live", observed_at: at.toISOString() });
      expect(listedAgents(f.db, new Date(at.getTime() + AGENT_OBSERVATION_TTL_MS - 1))[0]?.status).toBe("live");
      expect(listedAgents(f.db, new Date(at.getTime() + AGENT_OBSERVATION_TTL_MS))[0]?.status).toBe("stale");
      expect(listedAgents(f.db, new Date(at.getTime() - 1))[0]?.status).toBe("unknown");
      expect(listedAgents(f.db, new Date(Number.NaN))[0]?.status).toBe("unknown");
      f.supervisor.acknowledgeReport(cycle.report!.report_id, at.toISOString());
      const stopped = await f.supervisor.cycleAll(binding => [{ ...binding, state: "running", connected: false }], at.toISOString());
      expect(stopped.report).not.toBeNull();
      expect(listedAgents(f.db, at)[0]?.status).toBe("offline");
      f.db.close(); f.db.reopen();
      expect(listedAgents(f.db, at)[0]?.status).toBe("offline");
      f.supervisor.acknowledgeReport(stopped.report!.report_id, at.toISOString());
      const resumed = await f.supervisor.cycleAll(binding => [{ ...binding, state: "unknown", connected: true }], at.toISOString());
      expect(resumed.report).not.toBeNull(); expect(resumed.report!.report_id).not.toBe(cycle.report!.report_id);
      expect(resumed.report!.payload_digest).not.toBe(cycle.report!.payload_digest);
      expect(listedAgents(f.db, at)[0]?.status).toBe("live");
      f.supervisor.acknowledgeReport(resumed.report!.report_id, at.toISOString());
      await f.supervisor.cycleAll(binding => [{ ...binding, state: "running" }], at.toISOString());
      expect(listedAgents(f.db, at)[0]?.status).toBe("unknown");
    } finally { f.close(); }
  });

  it.each(["session_id", "incarnation_id", "updated_at"])("rejects mismatched or invalid persisted %s without repairing it in a read", async field => {
    const f = await fixture();
    try {
      await f.supervisor.cycleAll(binding => [{ ...binding, state: "running", connected: true }], at.toISOString());
      f.db.db.prepare(`UPDATE live_supervisor_cursors SET ${field}=?`).run("invalid");
      const before = f.db.db.prepare("SELECT total_changes() AS count").get();
      expect(listedAgents(f.db, at)[0]).toMatchObject({ status: "unknown", observed_at: null });
      expect(f.db.db.prepare("SELECT total_changes() AS count").get()).toEqual(before);
    } finally { f.close(); }
  });

  it("uses the same HTTP clock for list and detail without exposing session identity or writing", async () => {
    const f = await fixture();
    writeFileSync(join(f.root, "index.html"), "<!doctype html><title>JARVIS</title>");
    let now = at;
    const server = createDashboardServer({ db: f.db, staticRoot: f.root, host: "127.0.0.1", port: 0, clock: () => now });
    try {
      await f.supervisor.cycleAll(binding => [{ ...binding, state: "unknown", connected: true }], at.toISOString());
      const id = listedAgents(f.db, at)[0]!.agent_id;
      const origin = `http://${server.address.host}:${server.address.port}`;
      const before = f.db.db.prepare("SELECT total_changes() AS count").get();
      for (const [time, status] of [[at, "live"], [new Date(at.getTime() + AGENT_OBSERVATION_TTL_MS), "stale"]] as const) {
        now = time;
        const list = await request(`${origin}/api/v1/agents`);
        const detail = await request(`${origin}/api/v1/agents/${id}`);
        expect(list.statusCode).toBe(200); expect(detail.statusCode).toBe(200);
        const listBody = await list.body.json() as { items: unknown[] };
        const detailBody = await detail.body.json() as { agent: unknown };
        expect(listBody.items[0]).toMatchObject({ status }); expect(detailBody.agent).toEqual(listBody.items[0]);
        expect(JSON.stringify(listBody)).not.toContain("private-session");
      }
      expect(f.db.db.prepare("SELECT total_changes() AS count").get()).toEqual(before);
    } finally { server.close(); f.close(); }
  });

  it("records the structured terminal connection result and keeps probe failure unknown", async () => {
    const f = await fixture();
    try {
      const terminal = { handle: "terminal", ptyId: "pty", incarnationId: "incarnation", worktreeId: "worktree",
        worktreePath: null, title: "Codex", connected: true, writable: true, lastOutputAt: null, preview: null };
      const result = (value: unknown) => JSON.stringify({ ok: true, result: value });
      const read = { terminal: { handle: "terminal", status: "ok", tail: [], truncated: false, limited: false,
        oldestCursor: null, nextCursor: "cursor", latestCursor: "cursor", returnedLineCount: 0 } };
      expect((await observeBound(f.binding, async args => result(args[1] === "list" ? { terminals: [terminal] } : read)))[0]?.connected).toBe(true);
      expect((await observeBound(f.binding, async args => result(args[1] === "list" ? { terminals: [terminal] }
        : { terminal: { ...read.terminal, status: "running" } })))[0]?.connected).toBe(true);
      expect((await observeBound(f.binding, async () => result({ terminals: [{ ...terminal, connected: false }] })))[0]?.connected).toBe(false);
      expect((await observeBound(f.binding, async () => result({ terminals: [{ ...terminal, incarnationId: "replacement" }] })))[0]?.connected).toBeUndefined();
      expect((await observeBound(f.binding, async () => result({ terminals: [], truncated: true })))[0]?.connected).toBeUndefined();
      expect((await observeBound(f.binding, async () => { throw new JarvisError("ORCA_CLI_FAILED"); }))[0]?.connected).toBeUndefined();
      const wrongRead = await observeBound(f.binding, async args => result(args[1] === "list"
        ? { terminals: [terminal] } : { terminal: { ...read.terminal, handle: "another-terminal" } }));
      expect(wrongRead[0]).toMatchObject({ cursor: f.binding.cursor, state: "unknown" });
      expect(wrongRead[0]?.connected).toBeUndefined();
      const unavailableRead = await observeBound(f.binding, async args => result(args[1] === "list"
        ? { terminals: [terminal] } : { terminal: { ...read.terminal, status: "unavailable" } }));
      expect(unavailableRead[0]?.connected).toBeUndefined();
      const failedRead = await observeBound(f.binding, async args => {
        if (args[1] === "list") return result({ terminals: [terminal] });
        throw new JarvisError("ORCA_CLI_FAILED");
      });
      expect(failedRead[0]?.connected).toBeUndefined();
      await expect(observeBound(f.binding, async () => result({ terminals: [{}] })))
        .rejects.toMatchObject({ code: "ORCA_CLI_SCHEMA_INVALID" });
    } finally { f.close(); }
  });
});
