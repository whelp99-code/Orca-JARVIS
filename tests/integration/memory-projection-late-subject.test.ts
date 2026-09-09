import { createHmac } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { AuthorityDb } from "../../src/db.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { MemoryTombstoneChain } from "../../src/memory-tombstone-chain.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import { closeMemoryDatabase, memoryDatabase } from "../fixtures/memory-candidate-store.js";

const correction = (JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  vectors: { correction: { request: MemoryEffectWriteRequestV2 } };
}).vectors.correction.request;
const key = Buffer.alloc(32, 21);
const subject = `hmac-sha256:${createHmac("sha256", key)
  .update(correction.targets.map(target => target.subject_digest).sort().join("\0")).digest("hex")}`;
const now = new Date(correction.created_at);

it.each(["before", "after"])("suppresses subject-linked control reads when bound %s the tombstone", async order => {
  const f = await memoryDatabase();
  try {
    const projections = new MemoryProjectionAuthority(f.authority);
    const control = new ControlPlane(f.authority);
    for (const id of ["linked", "unrelated"]) control.stage({ schema_version: 1, request_id: id,
      action: "runbook.execute", action_level: 3, target: { environment: "local", runbook_id: "daemon-dead" },
      args: { runbook_id: "daemon-dead", args: { dry_run: true } }, reversible: true,
      requested_by: "principal:owner", requested_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 60000).toISOString(), nonce: id }, now);
    const ref = { kind: "control_payload" as const, id: "linked", component_id: "linked" };
    const bind = () => projections.bind(ref, [{ target_digest: `sha256:${"f".repeat(64)}`, keyed_subject_digest: subject }], now);
    if (order === "before") bind();
    const tombstone = new MemoryTombstoneChain(f.authority, key).append({ operation: "correct",
      lane_id: correction.lane_id, targets: correction.targets, target_manifest_digest: correction.target_manifest_digest,
      scope_digest: correction.scope_digest, authority_receipt_digest: correction.tombstone_chain_delta[0]!.authority_receipt_digest,
      payload_digest: correction.delegation.payload_digest, effective_at: correction.created_at });
    expect(tombstone.entry.keyed_subject_digest).toBe(subject);
    if (order === "after") bind();
    const unrelated = { ...ref, id: "unrelated", component_id: "unrelated" };
    projections.bind(unrelated, [{ target_digest: `sha256:${"e".repeat(64)}`,
      keyed_subject_digest: `hmac-sha256:${"d".repeat(64)}` }], now);
    const child = { kind: "dashboard_projection" as const, id: "child", component_id: "child" };
    projections.inherit(child, [ref], now);
    const before = f.authority.db.prepare("SELECT total_changes() AS n").get();
    expect(projections.isSuppressed(ref)).toBe(true);
    expect(projections.isSuppressed(child)).toBe(true);
    expect(control.get("linked")).toBeUndefined();
    expect(control.get("unrelated")?.request_id).toBe("unrelated");
    expect(f.authority.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  } finally { closeMemoryDatabase(f); }
});

it("repairs pre-existing late dependencies on upgrade without rewriting tombstones or events", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-late-subject-upgrade-"));
  const prefix = join(root, "migrations"); mkdirSync(prefix);
  for (const file of readdirSync("migrations").filter(file => file.endsWith(".sql") && file < "080_")) {
    copyFileSync(join("migrations", file), join(prefix, file));
  }
  let db = new AuthorityDb(join(root, "authority.sqlite"), prefix);
  try {
    await db.migrate();
    new MemoryTombstoneChain(db, key).append({ operation: "correct", lane_id: correction.lane_id,
      targets: correction.targets, target_manifest_digest: correction.target_manifest_digest,
      scope_digest: correction.scope_digest, authority_receipt_digest: correction.tombstone_chain_delta[0]!.authority_receipt_digest,
      payload_digest: correction.delegation.payload_digest, effective_at: correction.created_at });
    const insert = db.db.prepare(`INSERT INTO memory_projection_dependencies(projection_kind,projection_id,component_id,
      target_digest,keyed_subject_digest,created_at) VALUES('control_payload',?,?,?,?,?)`);
    insert.run("late", "late", `sha256:${"f".repeat(64)}`, subject, now.toISOString());
    insert.run("other", "other", `sha256:${"e".repeat(64)}`, `hmac-sha256:${"d".repeat(64)}`, now.toISOString());
    const tables = ["memory_tombstone_chain", "memory_suppressions", "memory_suppression_events", "memory_projection_dependencies"];
    const snapshot = () => tables.map(table => db.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    expect(new MemoryProjectionAuthority(db).isProjectionIdSuppressed("late")).toBe(false);
    db.close(); db = new AuthorityDb(join(root, "authority.sqlite"), resolve("migrations"));
    await db.migrate(); await db.migrate();
    expect(snapshot()).toEqual(before);
    expect(new MemoryProjectionAuthority(db).isProjectionIdSuppressed("late")).toBe(true);
    expect(new MemoryProjectionAuthority(db).isProjectionIdSuppressed("other")).toBe(false);
    expect(db.db.prepare("SELECT count(*) AS n FROM memory_projection_suppressions WHERE projection_id='late'").get())
      .toEqual({ n: 1 });
    expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
