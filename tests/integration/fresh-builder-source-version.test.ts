import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { buildFreshAuthority } from "../../src/memory-authority-fresh-builder.js";

const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) { try { db.close(); } catch { /* closed */ } } });

async function seeded(): Promise<AuthorityDb> {
  const db = new AuthorityDb(join(mkdtempSync(join(tmpdir(), "jarvis-builder-")), "authority.sqlite"));
  opened.push(db);
  await db.migrate();
  return db;
}

describe("fresh builder source version", () => {
  it("reports the version the candidate was read at, not the one a writer left behind", async () => {
    const source = await seeded();
    const fresh = join(mkdtempSync(join(tmpdir(), "jarvis-candidate-")), "candidate.sqlite");

    // A commit that lands while the copy is running. Delivered from the copy itself, so the order
    // is fixed: the candidate is already being read when the row appears in the source.
    const exec = Database.prototype.exec;
    let injected = 0;
    Database.prototype.exec = function patched(this: Database.Database, sql: string) {
      const result = exec.call(this, sql);
      if (injected === 0 && sql.includes("INSERT INTO") && sql.includes("source_authority")) {
        injected += 1;
        const writer = new Database(source.filename);
        try {
          writer.prepare(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,
            payload_digest,idempotency_key,state,created_at) VALUES('mid-copy','task:mid','dispatch',
            '{}','sha256:mid','mid-copy','pending','2026-08-28T12:00:00.000Z')`).run();
        } finally { writer.close(); }
      }
      return result;
    } as typeof Database.prototype.exec;

    let build;
    try {
      build = await buildFreshAuthority(source, fresh, { blocked_projections: [], sensitive_material: [] });
    } finally { Database.prototype.exec = exec; }
    expect(injected).toBe(1);

    const live = Number(source.db.pragma("data_version", { simple: true }));
    const candidate = new Database(fresh, { readonly: true });
    let copied = 0;
    try {
      copied = Number(candidate.prepare(
        "SELECT COUNT(*) FROM gjc_intents WHERE intent_id='mid-copy'").pluck().get());
    } finally { candidate.close(); }

    // The row is in the source and not in the candidate, so the version the builder reports must
    // not be the one that includes it - otherwise the swap compares the candidate against a source
    // it never read and finds them "unchanged".
    expect(copied).toBe(0);
    expect(build.source_data_version).not.toBe(live);
  }, 60_000);
});
