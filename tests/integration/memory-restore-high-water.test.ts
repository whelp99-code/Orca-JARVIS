import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { sanitizeMemoryRestoreCandidate } from "../../src/memory-restore-high-water.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { MemoryTombstoneChain } from "../../src/memory-tombstone-chain.js";
import type { ResolvedMemoryTargetV2 } from "../../src/second-brain-effect-v2.js";
import { tempDb } from "../helpers.js";

const target: ResolvedMemoryTargetV2 = { schema_version: 1,
  target_id: `sbtarget:v1:${"1".repeat(64)}`, target_digest: `sha256:${"1".repeat(64)}`,
  provider_instance_id: "provider:restore", generation_id: `sbgen:v1:${"2".repeat(64)}`,
  generation_manifest_digest: `sha256:${"2".repeat(64)}`, vault_head: "3".repeat(40),
  vault_tree: "4".repeat(40), page_id: "wiki/restore", page_blob_oid: "5".repeat(40),
  page_content_digest: `sha256:${"5".repeat(64)}`, source_identity_full: "6".repeat(64),
  content_identity_full: "7".repeat(64), citation_identity_full: "8".repeat(64),
  citation_span_start: 1, citation_span_end: 2, subject_digest: `sha256:${"9".repeat(64)}`,
  sensitivity: "personal", valid_from: "2026-08-31T00:00:00.000Z",
  valid_until: "2026-09-01T00:00:00.000Z", source_owner_class: "provider_owned",
  source_owner_id_digest: `sha256:${"a".repeat(64)}`, resolved_at: "2026-08-31T00:00:00.000Z",
  expires_at: "2026-08-31T00:05:00.000Z" };

describe("JARVIS restore tombstone high-water", () => {
  it("sanitizes a pre-forget database without activating it", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    const sentinel = `restore-${randomUUID()}-${randomUUID()}`;
    const root = mkdtempSync(join(tmpdir(), "jarvis-task30-restore-"));
    const source = join(root, "pre-forget.sqlite");
    try {
      const at = "2026-08-31T00:00:00.000Z";
      db.db.prepare(
        `INSERT INTO notification_intents(
          intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,redacted_preview,
          deep_link,state,expires_at,created_at,updated_at
         ) VALUES('intent:restore','corr:restore','idem:restore','dedup:restore','action',
          'mac',?,'/restore','created','2026-09-01T00:00:00.000Z',?,?)`,
      ).run(sentinel, at, at);
      db.db.prepare("UPDATE notification_intents SET state='queued' WHERE intent_id='intent:restore'").run();
      new MemoryProjectionAuthority(db).bind({ kind: "notification_intent",
        id: "intent:restore", component_id: "intent:restore" },
      [{ target_digest: target.target_digest }], new Date(at));
      await db.db.backup(source);
      const chain = new MemoryTombstoneChain(db, Buffer.alloc(32, 5));
      chain.append({ operation: "forget", lane_id: `memdel:req:v1:${"b".repeat(64)}`,
        targets: [target], target_manifest_digest: `sha256:${"c".repeat(64)}`,
        scope_digest: `sha256:${"d".repeat(64)}`, authority_receipt_digest: `sha256:${"e".repeat(64)}`,
        payload_digest: `sha256:${"f".repeat(64)}`, effective_at: "2026-08-31T00:00:00.000Z" });
      const result = await sanitizeMemoryRestoreCandidate({ authority: db, source,
        workspace: join(root, "workspace"), now: new Date("2026-08-31T00:00:01.000Z") });
      expect(result).toMatchObject({ disposition: "sanitized", activated: false,
        sanitized_path: expect.any(String) });
      if (typeof result.sanitized_path !== "string") throw new Error("MEMORY_RESTORE_FIXTURE_INVALID");
      const sanitized = readFileSync(result.sanitized_path);
      expect(sanitized.includes(Buffer.from(sentinel))).toBe(false);
      expect(db.db.prepare(
        "SELECT disposition,activated FROM memory_restore_high_water_receipts WHERE restore_id=?",
      ).get(result.restore_id)).toEqual({ disposition: "sanitized", activated: 0 });
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
