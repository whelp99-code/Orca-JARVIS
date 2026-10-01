import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir } from "node:process";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { tryExecuteWorkboardReplyGap } from "../../src/cli-workboard-reply-gap.js";
import { WorkboardStore } from "../../src/workboard/store.js";

describe("workboard migration path", () => {
  it("opens the projection migration when the process cwd is not the release root", () => {
    const away = mkdtempSync(join(tmpdir(), "wb-cwd-"));
    const previous = process.cwd();
    chdir(away);
    try {
      const db = new Database(":memory:");
      const store = new WorkboardStore(db);
      expect(store.works()).toEqual([]);
      db.close();
    } finally {
      chdir(previous);
    }
  });

  it("keeps a reply-gap rejection and does not disguise a store failure as a bad snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-cli-"));
    const missing = join(dir, "missing.json");
    await expect(tryExecuteWorkboardReplyGap({
      command: "workboard",
      subcommand: "ingest-reply-gap",
      argument: missing,
      values: { db: join(dir, "db.sqlite") },
      positionals: ["workboard", "ingest-reply-gap", missing],
      db: { db: new Database(":memory:") },
    } as never)).rejects.toMatchObject({ code: "MAIL_REPLY_GAP_SNAPSHOT_INVALID" });

    const file = join(dir, "snap.json");
    writeFileSync(file, JSON.stringify({ schema: 1, observedAt: "2026-10-01T00:00:00.000Z", open: [] }));
    const secret = "super-secret-token";
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(tryExecuteWorkboardReplyGap({
        command: "workboard",
        subcommand: "ingest-reply-gap",
        argument: file,
        values: { db: join(dir, "db.sqlite") },
        positionals: ["workboard", "ingest-reply-gap", file],
        db: { db: { exec() { throw new Error(`ENOENT: migrations/099_workboard_projection.sql token=${secret}`); } } },
      } as never)).rejects.toMatchObject({ code: "WORKBOARD_INGEST_FAILED" });
    } finally {
      process.stderr.write = original;
    }
    const logged = lines.join("");
    expect(logged).toContain("ENOENT");
    expect(logged).toContain("token=[redacted]");
    expect(logged).not.toContain(secret);
  });
});
