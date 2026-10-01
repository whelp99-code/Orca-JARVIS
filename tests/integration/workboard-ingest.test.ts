import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { WorkboardStore } from "../../src/workboard/store.js";
import { coverage, registerSource } from "../../src/workboard/source-registry.js";
import { metadataEvent } from "../../src/workboard/adapters/session-metadata.js";
import { terminalEvents } from "../../src/workboard/adapters/orca-terminals.js";

const path = resolve(".runtime-tmp/workboard/db/workboard.sqlite");
const source = { host: "linux", app: "codex", scope: "installation-1", generation: "initial" };
const event = (id: string, sequence: number, sessionId: string, taskId: string | null, overrides: Record<string, unknown> = {}) => ({
  source, eventId: id, sequence, sessionId, incarnation: "boot-1", taskId,
  receivedAt: "2026-09-24T00:00:00.000Z", sourceAt: "2026-09-24T00:00:00.000Z",
  state: "running", summary: "Implement the requested change", evidenceRef: "source://event/1",
  repo: "/repo", pid: 321, title: "terminal", ...overrides,
});

describe("workboard ingest identity", () => {
  it("deduplicates and orders events; rejects conflicts and malformed events", () => {
    mkdirSync(resolve(".runtime-tmp/workboard/db"), { recursive: true });
    rmSync(path, { force: true });
    const db = new Database(path); const store = new WorkboardStore(db);
    try {
      store.ingest(event("e2", 2, "session-a", "task-1", { state: "waiting" }));
      store.ingest(event("e1", 1, "session-a", "task-1", { state: "running" }));
      store.ingest(event("e2", 2, "session-a", "task-1", { state: "waiting" }));
      expect(store.works()).toHaveLength(1);
      expect(store.works()[0]).toMatchObject({ state: "waiting" });
      expect(() => store.ingest(event("e2", 2, "session-a", "task-1", { state: "failed" }))).toThrow(/CONFLICT/);
      expect(() => store.ingest(event("bad", -1, "session-a", "task-1"))).toThrow(/INVALID/);
    } finally { db.close(); }
  });
  it("ignores PID/title for identity, splits native tasks in the same repo, and preserves attempts", () => {
    rmSync(path, { force: true }); const db = new Database(path); const store = new WorkboardStore(db);
    try {
      store.ingest(event("a", 1, "session-a", "task-1"));
      store.ingest(event("b", 2, "session-a", "task-1", { pid: 999, title: "renamed", incarnation: "boot-2" }));
      store.ingest(event("c", 1, "session-b", "task-2", { pid: 321 }));
      store.ingest(event("d", 3, "session-a", "task-3"));
      expect(store.works()).toHaveLength(3);
      expect(store.sessions().filter(s => s.session_id === "session-a")).toHaveLength(1);
      expect(new Set(store.works().map(w => w.work_id)).size).toBe(3);
      expect(store.works().find(w => w.task_id === "task-1")?.attempt_count).toBe(2);
      store.outage("linux:codex:installation-1:initial", "timeout");
      expect(store.works().find(w => w.task_id === "task-1")).toMatchObject({ state: "running", warning: "timeout" });
    } finally { db.close(); }
  });
  it("keeps roster coverage unknown, canonicalizes history finder IDs, and ingests terminal handles without preview", () => {
    rmSync(path, { force: true }); const db = new Database(path); const store = new WorkboardStore(db);
    try {
      const roster = { source_key: "linux:codex:installation-1:initial", status: "live", page_completeness: "complete", total_kind: "file_roster", current_work_total: null, failure_reason: null };
      expect(coverage(roster)).toBe("unknown");
      registerSource(db, source, roster);
      expect(db.prepare("SELECT coverage FROM workboard_sources WHERE source_key=?").get(roster.source_key)).toEqual({ coverage: "unknown" });
      store.ingest(metadataEvent(source, { sessionId: "stable.history", incarnation: "one", eventId: "file-1", sequence: 1, observedAt: "2026-09-24T00:00:00.000Z", sourceAt: "2026-09-24T00:00:00.000Z", state: "unknown", summary: "Unclassified session", evidenceRef: "session://stable" }));
      store.ingest(metadataEvent(source, { sessionId: "stable", incarnation: "one", eventId: "file-2", sequence: 2, observedAt: "2026-09-24T00:01:00.000Z", sourceAt: "2026-09-24T00:01:00.000Z", state: "unknown", summary: "Unclassified session", evidenceRef: "session://stable" }));
      expect(store.works()).toHaveLength(1);
      const terminals = terminalEvents(JSON.stringify({ ok: true, result: { terminals: [{ handle: "term-1", incarnationId: "inc-1", preview: "private conversation" }] } }), { ...source, app: "orca-terminals" }, "2026-09-24T00:02:00.000Z");
      store.ingest(terminals[0]);
      expect(JSON.stringify(store.works())).not.toContain("private conversation");
      expect(store.works()).toHaveLength(2);
    } finally { db.close(); }
  });
  it("aliases only explicit cross-app session relations and retains parent-child work", () => {
    rmSync(path, { force: true }); const db = new Database(path); const store = new WorkboardStore(db);
    try {
      store.ingest(event("a", 1, "root", null));
      store.ingest(event("b", 1, "child", "task-child", { source: { ...source, app: "omo" }, parent: { source, sessionId: "root" } }));
      store.ingest(event("c", 1, "mirror", null, { source: { ...source, app: "orca" }, alias: { source, sessionId: "root" } }));
      store.ingest(event("d", 1, "guess", null, { source: { ...source, app: "claude" } }));
      expect(store.works()).toHaveLength(3);
      const root = store.works().find(w => w.session_id === "root");
      expect(store.works().find(w => w.task_id === "task-child")?.parent_work_id).toBe(root?.work_id);
      expect(store.works().find(w => w.session_id === "guess")?.work_id).not.toBe(root?.work_id);
    } finally { db.close(); }
  });
});
