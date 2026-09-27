import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkboardStore } from "../../src/workboard/store.js";
import { collectCurrentWork, linuxCurrentSources } from "../../src/workboard/adapters/current-work.js";

const observedAt = "2026-09-24T12:00:00.000Z";
const source = { host: "linux", app: "claude", scope: "local", generation: "initial" };

describe("bounded current-work collection", () => {
  it("excludes stale historical sessions and keeps the same work_id across observations", () => {
    const root = mkdtempSync(join(tmpdir(), "workboard-current-"));
    const directory = join(root, "sessions"); mkdirSync(directory);
    const db = new Database(":memory:"); const store = new WorkboardStore(db);
    try {
      writeFileSync(join(directory, "stale.json"), JSON.stringify({ sessionId: "stale.history", pid: 99999999,
        name: "Old goal", status: "running", startedAt: 1, updatedAt: 2 }));
      writeFileSync(join(directory, "live.json"), JSON.stringify({ sessionId: "live", pid: process.pid,
        name: "Current goal", status: "working", startedAt: 1790250000000, updatedAt: 1790251200000 }));
      const config = [{ source, directory, kind: "claude-live" as const }];
      const first = collectCurrentWork(store, config, observedAt);
      const second = collectCurrentWork(store, config, "2026-09-24T12:01:00.000Z");
      expect(first[0]?.ingested).toBe(1);
      expect(second[0]?.ingested).toBe(1);
      expect(store.works().map(w => w.session_id)).toEqual(["live"]);
      expect(new Set(store.works().map(w => w.work_id)).size).toBe(1);
      expect(store.works()[0]).toMatchObject({ summary: "Current goal", state: "running" });
      expect(JSON.stringify(store.works())).not.toContain("Old goal");
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("compares a read-only Linux collection with ingested current-work identities", () => {
    const db = new Database(":memory:"); const store = new WorkboardStore(db);
    try {
      const result = collectCurrentWork(store, linuxCurrentSources(process.env.HOME!), new Date().toISOString());
      const ids = store.works().map(w => w.session_id as string).sort();
      const collected = result.flatMap(r => r.currentIds).sort();
      expect(ids).toEqual(collected);
      expect(new Set(store.works().map(w => w.work_id)).size).toBe(store.works().length);
      console.log("CURRENT_WORK_MANUAL_QA", JSON.stringify({ sources: result, ingestedIds: ids,
        duplicateWorkIdCount: store.works().length - new Set(store.works().map(w => w.work_id)).size }));
    } finally { db.close(); }
  });
  it("does not keep a partial ingest or move the source clock when a later session fails", () => {
    const root = mkdtempSync(join(tmpdir(), "workboard-partial-"));
    const db = new Database(":memory:"); const store = new WorkboardStore(db);
    const prior = "2026-09-24T00:00:00.000Z";
    const sourceAt = new Date(1790251200000).toISOString();
    try {
      store.ingest({ source, eventId: "prior", sequence: 1, sessionId: "prior", incarnation: "old", taskId: null,
        receivedAt: prior, sourceAt: prior, state: "running", summary: "Already observed", evidenceRef: "prior" });
      const clashId = `clash:${sourceAt}:${observedAt}`;
      db.prepare("INSERT INTO workboard_events(source_key,event_id,digest,sequence,session_key,received_at) VALUES(?,?,?,?,?,?)")
        .run("linux:claude:local:initial", clashId, "stale-digest", 1, "session", prior);
      writeFileSync(join(root, "current.json"), JSON.stringify({ sessions: [
        { sessionId: "keep", pid: process.pid, name: "Keep", status: "working", updatedAt: 1790251200000, current: true },
        { sessionId: "clash", pid: process.pid, name: "Clash", status: "working", updatedAt: 1790251200000, current: true },
      ] }));
      const result = collectCurrentWork(store, [{ source, directory: root, kind: "current-manifest" }], observedAt);
      expect(result[0]).toMatchObject({ coverage: "unknown", ingested: 0, currentIds: [] });
      expect(store.works().map(work => work.session_id)).toEqual(["prior"]);
      expect(db.prepare("SELECT last_successful_observation,warning FROM workboard_sources").get())
        .toEqual({ last_successful_observation: prior, warning: "WORKBOARD_EVENT_CONFLICT" });
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("does not turn a historical roster into current work when no live metadata is available", () => {
    const root = mkdtempSync(join(tmpdir(), "workboard-roster-"));
    const db = new Database(":memory:"); const store = new WorkboardStore(db);
    try {
      writeFileSync(join(root, "archived.jsonl"), "historical transcript");
      const result = collectCurrentWork(store, [{ source: { ...source, app: "senpi" }, directory: root, kind: "current-manifest" }], observedAt);
      expect(result).toMatchObject([{ coverage: "unknown", ingested: 0 }]);
      expect(store.works()).toHaveLength(0);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
