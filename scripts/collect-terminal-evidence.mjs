#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { AuthorityDb } from "../dist/src/db.js";
import { ShellFallbackCollector } from "../dist/src/shell-fallback.js";
import { TerminalWorkMemory } from "../dist/src/terminal-work-memory.js";

const MAX_FRAME = 64 * 1024;
const spool = process.argv[2] ?? process.env.JARVIS_SHELL_SPOOL;
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (code) => output({ ok: false, code });
if (spool) {
  try { const info = await stat(spool); if (!info.isFile() || (info.mode & 0o077) !== 0) { fail("SHELL_FALLBACK_SPOOL_PERMISSIONS"); process.exitCode = 2; } }
  catch { fail("SHELL_FALLBACK_SPOOL_UNAVAILABLE"); process.exitCode = 2; }
}
if (process.exitCode !== 2) {
  const dbPath = process.env.JARVIS_DB;
  if (!dbPath) { fail("JARVIS_DB_REQUIRED"); process.exitCode = 2; }
  else {
    const db = new AuthorityDb(dbPath);
    try {
      await db.migrate(); await db.assertMigrationsReady();
      const collector = new ShellFallbackCollector(db.db); const memory = new TerminalWorkMemory(db.db);
      const source = spool ? Readable.from([await readFile(spool, "utf8")]) : process.stdin;
      const input = createInterface({ input: source, crlfDelay: Infinity });
      for await (const line of input) {
        if (Buffer.byteLength(line, "utf8") > MAX_FRAME) { fail("SHELL_FALLBACK_EVIDENCE_LIMIT"); continue; }
        let value;
        try {
          value = JSON.parse(line);
          if (value.event_id) { try { output({ ok: true, replay: true, event: memory.event(value.event_id) }); continue; } catch {} }
          const event = collector.ingest(value);
          output({ ok: true, event: event.event });
        } catch (error) {
          const code = error instanceof Error ? error.message : "SHELL_FALLBACK_INPUT_INVALID";
          if (code.includes("UNIQUE") && value?.event_id) { try { output({ ok: true, replay: true, event: memory.event(value.event_id) }); continue; } catch {} }
          fail(/^[A-Z][A-Z0-9_]+$/u.test(code) ? code : "SHELL_FALLBACK_INPUT_INVALID");
        }
      }
    } catch (error) { fail(error instanceof Error ? error.message : "SHELL_FALLBACK_FAILED"); process.exitCode = 2; }
    finally { db.close(); }
  }
}
