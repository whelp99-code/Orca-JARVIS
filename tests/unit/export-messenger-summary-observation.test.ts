import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/export-messenger-summary.mjs");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("export-messenger-summary observation ordering", () => {
  it("stamps observed_at after the private snapshot so rows in the copy stay valid", async () => {
    const { aggregate, summarizeDatabase } = await import(pathToFileURL(SCRIPT).href);
    const root = mkdtempSync(join(tmpdir(), "messenger-obs-"));
    roots.push(root);
    const inbox = join(root, "inbox.sqlite");
    const received = Date.now();
    const db = new Database(inbox);
    db.exec(`CREATE TABLE events (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      received INTEGER NOT NULL,
      delivered INTEGER,
      completed INTEGER,
      evidence TEXT
    )`);
    db.prepare("INSERT INTO events(id, payload, state, received) VALUES (?, ?, ?, ?)").run(
      "pending",
      JSON.stringify({ user: "UOWNER" }),
      "pending",
      received,
    );
    db.close();

    const ro = new Database(inbox, { readonly: true, fileMustExist: true });
    ro.pragma("query_only = ON");
    expect(() => aggregate(ro, "UOWNER", received - 1)).toThrowError("RECORD_INVALID");
    const { summary, observedMillis } = summarizeDatabase(ro, "UOWNER");
    ro.close();
    expect(observedMillis).toBeGreaterThanOrEqual(received);
    expect(summary).toMatchObject({ incomplete_count: 1, oldest_incomplete_age_ms: expect.any(Number) });
  });

  it("accepts a representative row received at wall-clock export time", () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-obs-"));
    roots.push(root);
    const dir = join(root, "out");
    mkdirSync(dir, { mode: 0o700 });
    const inbox = join(root, "inbox.sqlite");
    const output = join(dir, "summary.json");
    const received = Date.now();
    const db = new Database(inbox);
    db.exec(`CREATE TABLE events (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      received INTEGER NOT NULL,
      delivered INTEGER,
      completed INTEGER,
      evidence TEXT
    )`);
    db.prepare("INSERT INTO events(id, payload, state, received) VALUES (?, ?, ?, ?)").run(
      "pending",
      JSON.stringify({ user: "UOWNER" }),
      "pending",
      received,
    );
    db.close();

    const result = spawnSync(process.execPath, [
      SCRIPT,
      "--inbox", inbox,
      "--representative-user-id", "UOWNER",
      "--output", output,
    ], { cwd: ROOT, encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(readFileSync(output, "utf8"));
    expect(parsed.incomplete_count).toBe(1);
    expect(Date.parse(parsed.observed_at)).toBeGreaterThanOrEqual(received);
  });
});
