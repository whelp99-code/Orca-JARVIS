import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { AuthorityDb } from "../../src/db.js";
const at = "2026-09-09T01:00:00.000Z";
it("registers, collects, reads, holds, releases and expires through the CLI entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-cli-local-")); const path = join(root, "db.sqlite");
  try {
    const db = new AuthorityDb(path, "migrations");
    try {
      await db.migrate();
      db.db.exec(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at)
        VALUES ('a','task:cli','dispatch','{}','sha256:a','a','pending','2026-09-09T00:00:00.000Z')`);
    } finally { db.close(); }
    const run = (args: string[], clock = at) => execute(["timeline", ...args, "--db", path], { clock: () => new Date(clock) });
    await expect(run(["collect", "task:cli"])).rejects.toThrow("LOCAL_COLLECTION_UNREGISTERED");
    await expect(run(["register", "task:cli"])).resolves.toMatchObject({ registered: true });
    const collected = await run(["collect", "task:cli"]) as { snapshot: { collection_id: string } };
    const id = collected.snapshot.collection_id; const before = readFileSync(path);
    await expect(run(["subjects"])).resolves.toMatchObject({ subjects: [{ task_id: "task:cli", held: false,
      cached_collection_id: id, cached_expires_at: "2026-09-09T01:05:00.000Z" }] });
    // Inventory does not promote expired cache metadata to ready or mutate it during discovery.
    await expect(run(["subjects"], "2026-09-09T01:06:00.000Z")).resolves.toMatchObject({
      subjects: [{ cached_collection_id: id }] });
    await expect(run(["snapshot", "task:cli", id])).resolves.toMatchObject({ result: { state: "ready" } });
    expect(readFileSync(path).equals(before)).toBe(true);
    await expect(run(["hold", "task:cli"])).resolves.toMatchObject({ held: true });
    await expect(run(["subjects"])).resolves.toMatchObject({ subjects: [{ held: true, cached_collection_id: null }] });
    await expect(run(["collect", "task:cli"])).rejects.toThrow("LOCAL_COLLECTION_HELD");
    await expect(run(["release", "task:cli"])).resolves.toMatchObject({ held: false });
    await expect(run(["snapshot", "task:cli", id])).resolves.toMatchObject({ result: { reason: "snapshot_missing" } });
    await run(["collect", "task:cli"]);
    await expect(run(["expire"], "2026-09-09T01:05:00.000Z")).resolves.toMatchObject({ expired_snapshots: 1 });
    await expect(run(["subjects"])).resolves.toMatchObject({ subjects: [{ held: false, cached_collection_id: null }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("rejects missing explicit databases, extra arguments and irrelevant options before DB creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-cli-local-input-")); const path = join(root, "missing.sqlite");
  try {
    await expect(execute(["timeline", "subjects", "task:x", "--db", path])).rejects.toThrow("LOCAL_COLLECTION_INPUT_INVALID");
    await expect(execute(["timeline", "subjects", "--db", path])).rejects.toThrow("LOCAL_COLLECTION_DATABASE_UNAVAILABLE");
    await expect(execute(["timeline", "collect", "task:x"])).rejects.toThrow("LOCAL_COLLECTION_INPUT_INVALID");
    await expect(execute(["timeline", "collect", "task:x", "extra", "--db", path])).rejects.toThrow("LOCAL_COLLECTION_INPUT_INVALID");
    await expect(execute(["timeline", "collect", "task:x", "--db", path, "--limit", "1"])).rejects.toThrow("LOCAL_COLLECTION_INPUT_INVALID");
    await expect(execute(["timeline", "register", "task:x", "--db", path])).rejects.toThrow("LOCAL_COLLECTION_DATABASE_UNAVAILABLE");
    expect(existsSync(path)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
