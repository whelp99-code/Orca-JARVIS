import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { describe, expect, it } from "vitest";
import * as Jarvis from "../../src/index.js";
import { AuthorityDb } from "../../src/db.js";
import type { ResolvedMemoryTargetV2 } from "../../src/second-brain-effect-v2.js";
import {
  providerSurfaceInventory,
  reingressGuardObservations,
} from "../fixtures/memory-surface-observations.js";
import { tempDb } from "../helpers.js";

const GENESIS = "sha256:7fb694c8abb7c9a4477aa38381c49446493bc4da1c01b50690c1db5b2c20b9d3";

function target(): ResolvedMemoryTargetV2 {
  return { schema_version: 1, target_id: `sbtarget:v1:${"1".repeat(64)}`,
    target_digest: `sha256:${"1".repeat(64)}`, provider_instance_id: "provider:test",
    generation_id: `sbgen:v1:${"2".repeat(64)}`,
    generation_manifest_digest: `sha256:${"2".repeat(64)}`, vault_head: "3".repeat(40),
    vault_tree: "4".repeat(40), page_id: "wiki/test", page_blob_oid: "5".repeat(40),
    page_content_digest: `sha256:${"5".repeat(64)}`, source_identity_full: "6".repeat(64),
    content_identity_full: "7".repeat(64), citation_identity_full: "8".repeat(64),
    citation_span_start: 1, citation_span_end: 2, subject_digest: `sha256:${"9".repeat(64)}`,
    sensitivity: "personal", valid_from: "2026-08-31T00:00:00.000Z",
    valid_until: "2026-09-01T00:00:00.000Z", source_owner_class: "provider_owned",
    source_owner_id_digest: `sha256:${"a".repeat(64)}`,
    resolved_at: "2026-08-31T00:00:00.000Z", expires_at: "2026-08-31T00:05:00.000Z" };
}

function isConstructor(value: unknown): value is new (...args: readonly unknown[]) => object {
  return typeof value === "function";
}

describe("quiesced fresh-file AuthorityDb reconstruction", () => {
  it("atomically changes inode, preserves unrelated data, and disposes old physical content", async () => {
    // Given: one suppressed notification projection, one unrelated row, and complete fixed roots.
    const root = mkdtempSync(join(tmpdir(), "jarvis-task30-compact-"));
    const db = new AuthorityDb(tempDb()); await db.migrate();
    const old = `old-"${randomUUID()}"\n\\${randomUUID()}`;
    const unrelated = `unrelated-${randomUUID()}`;
    let holder: ChildProcessWithoutNullStreams | undefined;
    let holderLines: Interface | undefined;
    try {
      const layout = { spool_root: join(root, "spool"), state_root: join(root, "state"),
        dist_root: join(root, "release", "dist"), backup_root: join(root, "backups"),
        restore_root: join(root, "restore") };
      for (const path of Object.values(layout)) mkdirSync(path, { recursive: true, mode: 0o700 });
      const rollout = join(layout.state_root, "rollout.jsonl");
      const history = join(layout.backup_root, "history.sqlite");
      writeFileSync(rollout, JSON.stringify({ prompt: old }) + "\n", { mode: 0o600 });
      const historyDb = new Database(history);
      try {
        historyDb.exec("CREATE TABLE history (prompt TEXT NOT NULL)");
        historyDb.prepare("INSERT INTO history VALUES (?)")
          .run(JSON.stringify({ request: JSON.stringify({ prompt: old }) }));
      } finally { historyDb.close(); }
      expect(readFileSync(history).includes(Buffer.from(old))).toBe(false);
      const at = "2026-08-31T00:00:00.000Z";
      db.db.prepare(
        `INSERT INTO notification_intents(
          intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,redacted_preview,
          deep_link,state,expires_at,created_at,updated_at
         ) VALUES(?,?,?,?,?,'mac',?,?,'created',?,?,?)`,
      ).run("intent:target", "corr:target", "idem:target", "dedup:target", "action", old,
        "/target", "2026-09-01T00:00:00.000Z", at, at);
      db.db.prepare(
        `INSERT INTO notification_intents(
          intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,redacted_preview,
          deep_link,state,expires_at,created_at,updated_at
         ) VALUES(?,?,?,?,?,'mac',?,?,'created',?,?,?)`,
      ).run("intent:unrelated", "corr:unrelated", "idem:unrelated", "dedup:unrelated",
        "action", unrelated, "/unrelated", "2026-09-01T00:00:00.000Z", at, at);
      db.db.prepare("UPDATE notification_intents SET state='queued' WHERE state='created'").run();
      const projection = Reflect.get(Jarvis, "MemoryProjectionAuthority");
      if (!isConstructor(projection)) throw new Error("MEMORY_PROJECTION_FIXTURE_INVALID");
      const authority = Reflect.construct(projection, [db]);
      const bind = Reflect.get(authority, "bind");
      if (typeof bind !== "function") throw new Error("MEMORY_PROJECTION_FIXTURE_INVALID");
      Reflect.apply(bind, authority, [{ kind: "notification_intent", id: "intent:target",
        component_id: "intent:target" }, [{ target_digest: target().target_digest }], new Date(at)]);
      const appended = new Jarvis.MemoryTombstoneChain(db, Buffer.alloc(32, 3)).append({
        operation: "forget", lane_id: `memdel:req:v1:${"b".repeat(64)}`, targets: [target()],
        target_manifest_digest: `sha256:${"c".repeat(64)}`,
        scope_digest: `sha256:${"d".repeat(64)}`,
        authority_receipt_digest: `sha256:${"e".repeat(64)}`,
        payload_digest: `sha256:${"f".repeat(64)}`, effective_at: at });
      expect(appended.entry.previous_root).toBe(GENESIS);
      const source = statSync(db.filename);
      holder = spawn(process.execPath, ["-e", [
        "const fs=require('node:fs');",
        "const readline=require('node:readline');",
        "const lines=readline.createInterface({input:process.stdin});",
        "lines.once('line',path=>{const fd=fs.openSync(path,'r');process.stdout.write('ready\\n');",
        "lines.once('line',()=>{fs.closeSync(fd);process.exit(0)});});",
      ].join("")]);
      holderLines = createInterface({ input: holder.stdout });
      const ready = once(holderLines, "line", { signal: AbortSignal.timeout(5_000) });
      holder.stdin.write(`${db.filename}\n`);
      expect((await ready)[0]).toBe("ready");
      const runtimeType = Reflect.get(Jarvis, "AuthorityDatabaseRuntime");
      const scannerType = Reflect.get(Jarvis, "MemoryManagedSurfaceScanner");
      const compactorType = Reflect.get(Jarvis, "MemoryAuthorityCompactor");
      expect(isConstructor(runtimeType) && isConstructor(scannerType) && isConstructor(compactorType)).toBe(true);
      if (!isConstructor(runtimeType) || !isConstructor(scannerType) || !isConstructor(compactorType)) return;
      const runtime = Reflect.construct(runtimeType, [db, { registry_root: join(root, "registry"), watchdog_ms: 5_000 }]);
      const scanner = Reflect.construct(scannerType, [{ authority: db, layout }]);
      const compactor = Reflect.construct(compactorType, [{ runtime, scanner, layout }]);
      const compact = Reflect.get(compactor, "compact");
      if (typeof compact !== "function") throw new Error("MEMORY_COMPACTOR_FIXTURE_INVALID");

      // When: an independent process holds the old inode through the atomic swap.
      await expect(Reflect.apply(compact, compactor, [{ lane: "deletion",
        lane_id: `memdel:req:v1:${"b".repeat(64)}`,
        target_manifest_digest: `sha256:${"c".repeat(64)}`,
        scope_digest: `sha256:${"d".repeat(64)}`,
        tombstone: { sequence: appended.entry.sequence, set_root: appended.entry.set_root },
        provider_inventory: providerSurfaceInventory(),
        reingress_guards: reingressGuardObservations() }]))
        .rejects.toMatchObject({ code: "MEMORY_OLD_DATABASE_FD_ACTIVE" });
      const job: unknown = db.db.prepare(
        "SELECT purge_id FROM memory_purge_jobs WHERE state='reconciling'",
      ).get();
      const purgeId = typeof job === "object" && job !== null ? Reflect.get(job, "purge_id") : undefined;
      if (typeof purgeId !== "string") throw new Error("MEMORY_PURGE_JOB_MISSING");
      const exited = once(holder, "exit", { signal: AbortSignal.timeout(5_000) });
      holder.stdin.write("release\n");
      await exited;
      holderLines.close(); holderLines = undefined; holder = undefined;
      const recover = Reflect.get(compactor, "recover");
      if (typeof recover !== "function") throw new Error("MEMORY_COMPACTOR_FIXTURE_INVALID");
      const result = await Reflect.apply(recover, compactor, [purgeId]);

      // Then: completion waits for real FD release, preserves unrelated data, and removes old bytes.
      const active = statSync(db.filename);
      expect(active.ino).not.toBe(source.ino);
      expect(result).toMatchObject({ integrity_check: "ok", foreign_key_errors: 0,
        old_database_disposed: true, old_fd_count: 0,
        inventory: { expected_surface_count: 70, observed_surface_count: 70 } });
      await Reflect.apply(Reflect.get(runtime, "close"), runtime, []);
      expect(readFileSync(db.filename).includes(Buffer.from(old))).toBe(false);
      expect(readFileSync(db.filename).includes(Buffer.from(unrelated))).toBe(true);
      expect([rollout, history].map(existsSync)).toEqual([false, false]);
      expect(["-wal", "-shm", "-journal"].some(suffix => existsSync(`${db.filename}${suffix}`))).toBe(false);
    } finally {
      holderLines?.close();
      if (holder?.exitCode === null) holder.kill("SIGKILL");
      if (db.db.open) db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000); // Multiple full-schema rebuilds plus a real child-process FD drain.
});
