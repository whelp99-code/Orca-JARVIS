import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/export-messenger-summary.mjs");
const BODY = "synthetic-body-token";
const UID = "UOWNER";
const DDL = `CREATE TABLE events (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  received INTEGER NOT NULL,
  delivered INTEGER,
  completed INTEGER,
  evidence TEXT
)`;
const RECEIVED = 1_700_000_000_000;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): { readonly root: string; readonly dir: string } {
  const root = mkdtempSync(join(tmpdir(), "messenger-summary-"));
  roots.push(root);
  const dir = join(root, "out");
  mkdirSync(dir, { mode: 0o700 });
  return { root, dir };
}

function payload(user: string, extra: Record<string, string> = {}): string {
  return JSON.stringify({ user, text: BODY, channel: "C1", ts: "1.0", ...extra });
}

function seed(path: string, rows: readonly { readonly id: string; readonly payload: string; readonly state: string; readonly received: number }[]): string {
  const db = new Database(path);
  db.pragma("journal_mode = DELETE");
  db.exec(DDL);
  const insert = db.prepare("INSERT INTO events(id, payload, state, received) VALUES (?, ?, ?, ?)");
  for (const row of rows) insert.run(row.id, row.payload, row.state, row.received);
  db.close();
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(inbox: string, output: string, uid = UID, umask?: number) {
  const previous = umask === undefined ? undefined : process.umask(umask);
  try {
    return spawnSync(process.execPath, [
      SCRIPT,
      "--inbox", inbox,
      "--representative-user-id", uid,
      "--output", output,
    ], { cwd: ROOT, encoding: "utf8", timeout: 10000 });
  } finally {
    if (previous !== undefined) process.umask(previous);
  }
}

function snapshot(output: string) {
  const text = readFileSync(output, "utf8");
  const parsed: unknown = JSON.parse(text);
  return { text, parsed };
}

describe("export-messenger-summary", () => {
  it("counts only the representative pending and processing rows when others are excluded", () => {
    const { root, dir } = workspace();
    const inbox = join(root, "inbox.sqlite");
    const output = join(dir, "summary.json");
    const digest = seed(inbox, [
      { id: "other", payload: payload("UOTHER"), state: "weird", received: RECEIVED - 50_000 },
      { id: "other-future", payload: payload("UOTHER"), state: "pending", received: Date.now() + 86_400_000 },
      { id: "pending", payload: payload(UID), state: "pending", received: RECEIVED },
      { id: "processing", payload: payload(UID), state: "processing", received: RECEIVED + 5_000 },
      { id: "done", payload: payload(UID), state: "completed", received: RECEIVED - 10_000 },
      { id: "bot", payload: payload(UID, { bot_id: "B1" }), state: "pending", received: RECEIVED - 20_000 },
      { id: "bot-message", payload: payload(UID, { subtype: "bot_message" }), state: "pending", received: RECEIVED - 30_000 },
      { id: "changed", payload: payload(UID, { subtype: "message_changed" }), state: "pending", received: RECEIVED - 40_000 },
      { id: "deleted", payload: payload(UID, { subtype: "message_deleted" }), state: "pending", received: RECEIVED - 60_000 },
    ]);
    const result = run(inbox, output, UID, 0o077);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ok\n");
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(BODY);
    expect(result.stderr).not.toContain(BODY);
    const { text, parsed } = snapshot(output);
    expect(text).not.toContain(BODY);
    expect(text).not.toContain(UID);
    expect(parsed).toEqual({
      schema_version: 1,
      observed_at: expect.any(String),
      incomplete_count: 2,
      oldest_incomplete_age_ms: expect.any(Number),
    });
    expect(parsed && typeof parsed === "object" ? Object.keys(parsed) : []).toEqual([
      "schema_version", "observed_at", "incomplete_count", "oldest_incomplete_age_ms",
    ]);
    const observed = parsed && typeof parsed === "object" && "observed_at" in parsed ? parsed.observed_at : "";
    const age = parsed && typeof parsed === "object" && "oldest_incomplete_age_ms" in parsed
      ? parsed.oldest_incomplete_age_ms : undefined;
    expect(typeof observed).toBe("string");
    expect(age).toBe(Date.parse(String(observed)) - RECEIVED);
    expect(statSync(output).mode & 0o777).toBe(0o640);
    expect(createHash("sha256").update(readFileSync(inbox)).digest("hex")).toBe(digest);
    expect(readdirSync(root).filter((name) => name.endsWith("-wal") || name.endsWith("-shm"))).toEqual([]);
    const db = new Database(inbox, { readonly: true, fileMustExist: true });
    const states = db.prepare("SELECT id, state FROM events ORDER BY id").all();
    db.close();
    expect(states).toEqual([
      { id: "bot", state: "pending" },
      { id: "bot-message", state: "pending" },
      { id: "changed", state: "pending" },
      { id: "deleted", state: "pending" },
      { id: "done", state: "completed" },
      { id: "other", state: "weird" },
      { id: "other-future", state: "pending" },
      { id: "pending", state: "pending" },
      { id: "processing", state: "processing" },
    ]);
  });

  it("writes a null age when no representative work is incomplete", () => {
    const { root, dir } = workspace();
    const inbox = join(root, "inbox.sqlite");
    const output = join(dir, "summary.json");
    seed(inbox, []);
    const result = run(inbox, output);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ok\n");
    const { parsed } = snapshot(output);
    expect(parsed).toMatchObject({ schema_version: 1, incomplete_count: 0, oldest_incomplete_age_ms: null });
  });

  it("refuses a normalized output alias of the source database", () => {
    // Given a valid source and an output spelling that resolves back to it.
    const { root, dir } = workspace();
    const inbox = join(root, "inbox.sqlite");
    const digest = seed(inbox, [{ id: "pending", payload: payload(UID), state: "pending", received: RECEIVED }]);
    // When the output uses an existing child directory followed by parent traversal.
    const result = run(inbox, `${dir}/../inbox.sqlite`);
    // Then publication refuses and preserves the original database bytes.
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("OUTPUT_INVALID\n");
    expect(createHash("sha256").update(readFileSync(inbox)).digest("hex")).toBe(digest);
  });

  it("refuses a symlink ancestor of the publication directory", () => {
    // Given a genuine private directory reached through an ancestor symlink.
    const { root, dir } = workspace();
    const inbox = join(root, "inbox.sqlite");
    seed(inbox, []);
    mkdirSync(join(dir, "nested"), { mode: 0o700 });
    const alias = join(root, "alias");
    symlinkSync(dir, alias);
    // When exporting below that symlink rather than directly into it.
    const result = run(inbox, join(alias, "nested", "summary.json"));
    // Then the exporter enforces the same canonical-directory contract as JARVIS.
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("OUTPUT_INVALID\n");
    expect(readdirSync(join(dir, "nested"))).toEqual([]);
  });

  it("fails closed on a bad representative record and keeps the previous output", () => {
    const { root, dir } = workspace();
    const inbox = join(root, "inbox.sqlite");
    const output = join(dir, "summary.json");
    writeFileSync(output, "KEEP\n", { mode: 0o600 });
    const cases = [
      [{ id: "bad-json", payload: "{", state: "pending", received: RECEIVED }],
      [{ id: "future", payload: payload(UID), state: "pending", received: Date.now() + 60_000 }],
      [{ id: "negative", payload: payload(UID), state: "pending", received: -1 }],
      [{ id: "state", payload: payload(UID), state: "failed", received: RECEIVED }],
    ];
    for (const rows of cases) {
      rmSync(inbox, { force: true });
      const digest = seed(inbox, rows);
      const result = run(inbox, output);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("RECORD_INVALID\n");
      expect(result.stderr).not.toContain(BODY);
      expect(readFileSync(output, "utf8")).toBe("KEEP\n");
      expect(createHash("sha256").update(readFileSync(inbox)).digest("hex")).toBe(digest);
      expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
    }
  });

  it("rejects an unsafe output directory, a symlink destination, and a missing database", () => {
    const { root, dir } = workspace();
    const inbox = join(root, "inbox.sqlite");
    seed(inbox, [{ id: "pending", payload: payload(UID), state: "pending", received: RECEIVED }]);
    chmodSync(dir, 0o777);
    const unsafe = run(inbox, join(dir, "summary.json"));
    expect(unsafe.status).toBe(1);
    expect(unsafe.stderr).toBe("OUTPUT_INVALID\n");
    expect(unsafe.stdout).not.toContain(BODY);
    chmodSync(dir, 0o700);

    const linkDir = join(root, "linked-out");
    symlinkSync(dir, linkDir);
    const linkedDir = run(inbox, join(linkDir, "summary.json"));
    expect(linkedDir.status).toBe(1);
    expect(linkedDir.stderr).toBe("OUTPUT_INVALID\n");

    const dest = join(dir, "summary.json");
    symlinkSync(join(root, "elsewhere.json"), dest);
    const linkedDest = run(inbox, dest);
    expect(linkedDest.status).toBe(1);
    expect(linkedDest.stderr).toBe("OUTPUT_INVALID\n");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    const fifo = join(dir, "summary.fifo");
    expect(spawnSync("/usr/bin/mkfifo", [fifo]).status).toBe(0);
    const piped = run(inbox, fifo);
    expect(piped.status).toBe(1);
    expect(piped.stderr).toBe("OUTPUT_INVALID\n");
    expect(lstatSync(fifo).isFIFO()).toBe(true);

    const missing = run(join(root, "missing.sqlite"), join(dir, "other.json"));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe("SOURCE_INVALID\n");
    expect(readdirSync(dir).sort()).toEqual(["summary.fifo", "summary.json"]);
  });
});
