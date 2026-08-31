import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { purgeMemoryContent } from "../../src/memory-content-purge.js";
import { MemoryTombstoneChain } from "../../src/memory-tombstone-chain.js";
import type { ResolvedMemoryTargetV2 } from "../../src/second-brain-effect-v2.js";
import { tempDb } from "../helpers.js";

function target(): ResolvedMemoryTargetV2 {
  return { schema_version: 1, target_id: `sbtarget:v1:${"1".repeat(64)}`,
    target_digest: `sha256:${"1".repeat(64)}`, provider_instance_id: "provider:test",
    generation_id: `sbgen:v1:${"2".repeat(64)}`, generation_manifest_digest: `sha256:${"2".repeat(64)}`,
    vault_head: "3".repeat(40), vault_tree: "4".repeat(40), page_id: "wiki/test",
    page_blob_oid: "5".repeat(40), page_content_digest: `sha256:${"5".repeat(64)}`,
    source_identity_full: "6".repeat(64), content_identity_full: "7".repeat(64),
    citation_identity_full: "8".repeat(64), citation_span_start: 1, citation_span_end: 2,
    subject_digest: `sha256:${"9".repeat(64)}`, sensitivity: "personal",
    valid_from: "2026-08-31T00:00:00.000Z", valid_until: "2026-09-01T00:00:00.000Z",
    source_owner_class: "provider_owned", source_owner_id_digest: `sha256:${"a".repeat(64)}`,
    resolved_at: "2026-08-31T00:00:00.000Z", expires_at: "2026-08-31T00:05:00.000Z" };
}

describe("JARVIS content propagation and compaction", () => {
  it("removes target plaintext from SQLite physical bytes and managed backups", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    const old = `old-${randomUUID()}-${randomUUID()}`;
    const unrelated = `unrelated-${randomUUID()}`;
    const root = mkdtempSync(join(tmpdir(), "jarvis-task30-purge-"));
    const backups = join(root, "backups"); mkdirSync(backups, { mode: 0o700 });
    try {
      db.db.exec("CREATE TABLE task30_projection(id TEXT PRIMARY KEY,payload TEXT NOT NULL)");
      db.db.prepare("INSERT INTO task30_projection VALUES('target',?)").run(`${old}:${unrelated}`);
      writeFileSync(join(backups, "target.backup"), old, { mode: 0o600 });
      const chain = new MemoryTombstoneChain(db, Buffer.alloc(32, 2));
      const appended = chain.append({ operation: "forget", lane_id: `memdel:req:v1:${"b".repeat(64)}`,
        targets: [target()], target_manifest_digest: `sha256:${"c".repeat(64)}`,
        scope_digest: `sha256:${"d".repeat(64)}`, authority_receipt_digest: `sha256:${"e".repeat(64)}`,
        payload_digest: `sha256:${"f".repeat(64)}`, effective_at: "2026-08-31T00:00:00.000Z" });
      const result = purgeMemoryContent({ authority: db, lane: "deletion",
        lane_id: `memdel:req:v1:${"b".repeat(64)}`,
        target_manifest_digest: `sha256:${"c".repeat(64)}`,
        scope_digest: `sha256:${"d".repeat(64)}`, tombstone_sequence: appended.entry.sequence,
        tombstone_set_root: appended.entry.set_root, needles: [Buffer.from(old)],
        backup_roots: [backups], now: new Date("2026-08-31T00:00:01.000Z") });
      expect(result).toMatchObject({ replaced_cells: 1, disposed_backups: 1,
        inventory: { match_count: 0, error_count: 0 } });
      db.close();
      const physical = readFileSync(db.filename);
      expect(physical.includes(Buffer.from(old))).toBe(false);
      expect(physical.includes(Buffer.from(unrelated))).toBe(true);
    } finally { if (db.db.open) db.close(); }
  });
});
