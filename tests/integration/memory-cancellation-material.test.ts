import { chmodSync, linkSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { collectCancellationMaterial } from "../../src/memory-cancellation-material.js";
import { MemoryCorrectionCancellationIssuer } from "../../src/memory-correction-cancellation-issuer.js";
import { countForbiddenContentMatches, loadForbiddenContentIdentities } from "../../src/memory-forbidden-content.js";
import { cancellationDatabaseFixture } from "../fixtures/memory-cancellation-db.js";

async function fixture() {
  const f = await cancellationDatabaseFixture();
  const intent = new MemoryCorrectionCancellationIssuer(f.db, f.runtime.clock)
    .issue(f.record.correction_id, f.runtime.signing_key_id, f.runtime.private_key);
  const at = f.runtime.clock().toISOString();
  f.db.db.prepare(`INSERT INTO memory_purge_jobs(purge_id,lane,lane_id,target_manifest_digest,scope_digest,
    tombstone_sequence,tombstone_set_root,state,created_at,updated_at) VALUES('purge:test','correction',?,?,?,?,?,'pending',?,?)`)
    .run(f.record.lane_id, intent.original_delegation.target_manifest_digest, intent.original_delegation.scope_digest,
      intent.tombstone.sequence, intent.tombstone.set_root, at, at);
  return { ...f, collect: () => collectCancellationMaterial(f.db, f.runtime.spool_root, "purge:test", f.runtime.clock()) };
}

it("captures authenticated spool material before deletion and resumes from body-free immutable evidence", async () => {
  const f = await fixture();
  try {
    const buffers = await f.collect();
    expect(buffers.map(value => value.toString())).toEqual([f.staged.content]);
    buffers.forEach(value => value.fill(0));
    const saved = f.db.db.prepare("SELECT * FROM memory_cancellation_material_checkpoints").all();
    expect(saved).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain(f.staged.content);
    expect(() => f.db.db.exec("DELETE FROM memory_cancellation_material_checkpoints")).toThrow("immutable");
    expect(() => f.db.db.exec("INSERT OR REPLACE INTO memory_cancellation_material_checkpoints SELECT * FROM memory_cancellation_material_checkpoints")).toThrow("immutable");
    rmSync(f.spoolPath);
    expect(await f.collect()).toEqual([]);
    const identities = loadForbiddenContentIdentities(f.db);
    expect(countForbiddenContentMatches(Buffer.from(f.staged.content), identities)).toBeGreaterThan(0);
    expect(countForbiddenContentMatches(Buffer.from(JSON.stringify(f.staged.content)), identities)).toBeGreaterThan(0);
    expect(f.writer.calls).toHaveLength(0);
    expect(f.db.db.prepare("SELECT * FROM memory_cancellation_material_checkpoints").all()).toEqual(saved);
  } finally { await f.close(); }
});

it.each(["missing", "tampered", "mode", "symlink", "hardlink"] as const)("rejects %s spool without capturing evidence", async mode => {
  const f = await fixture();
  const other = f.spoolPath + ".other";
  try {
    if (mode === "missing") rmSync(f.spoolPath);
    if (mode === "tampered") writeFileSync(f.spoolPath, "{}\n");
    if (mode === "mode") chmodSync(f.spoolPath, 0o644);
    if (mode === "hardlink") linkSync(f.spoolPath, other);
    if (mode === "symlink") {
      writeFileSync(other, readFileSync(f.spoolPath), { mode: 0o600 });
      rmSync(f.spoolPath); symlinkSync(other, f.spoolPath);
    }
    await expect(f.collect()).rejects.toThrow();
    expect(f.db.db.prepare("SELECT count(*) AS n FROM memory_cancellation_material_checkpoints").get()).toEqual({ n: 0 });
    expect(loadForbiddenContentIdentities(f.db)).toEqual([]);
  } finally { rmSync(other, { force: true }); await f.close(); }
});

it("rolls back identities when checkpoint persistence fails", async () => {
  const f = await fixture();
  try {
    f.db.db.exec(`CREATE TRIGGER injected_failure BEFORE INSERT ON memory_cancellation_material_checkpoints
      BEGIN SELECT RAISE(ABORT,'injected checkpoint failure'); END`);
    await expect(f.collect()).rejects.toThrow("injected checkpoint failure");
    expect(loadForbiddenContentIdentities(f.db)).toEqual([]);
    expect(readFileSync(f.spoolPath, "utf8")).toContain(f.staged.content);
  } finally { await f.close(); }
});

it("serializes concurrent captures into one immutable checkpoint", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all([f.collect(), f.collect()]);
    for (const buffers of results) {
      expect(buffers.map(value => value.toString())).toEqual([f.staged.content]);
      buffers.forEach(value => value.fill(0));
    }
    expect(f.db.db.prepare("SELECT count(*) AS n FROM memory_cancellation_material_checkpoints").get()).toEqual({ n: 1 });
  } finally { await f.close(); }
});

it("rejects a damaged checkpoint after the original spool disappears", async () => {
  const f = await fixture();
  try {
    (await f.collect()).forEach(value => value.fill(0));
    rmSync(f.spoolPath);
    // Simulate storage corruption; ordinary SQL writes are rejected by the trigger.
    f.db.db.exec("DROP TRIGGER memory_cancellation_material_no_update");
    f.db.db.exec("UPDATE memory_cancellation_material_checkpoints SET identity_manifest_digest='sha256:bad'");
    await expect(f.collect()).rejects.toThrow("MEMORY_CANCELLATION_MATERIAL_UNPROVED");
  } finally { await f.close(); }
});
