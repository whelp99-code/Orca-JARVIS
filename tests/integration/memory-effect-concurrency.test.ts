import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { MemoryCorrectionStore } from "../../src/memory-correction-store.js";
import { tempDb } from "../helpers.js";

const NOW = new Date("2026-08-31T00:00:01.000Z");
const digest = `sha256:${"1".repeat(64)}`;

describe("memory effect one-send concurrency", () => {
  it("allows 32 workers to spend exactly one correction dispatch fence", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      db.db.pragma("foreign_keys=OFF");
      db.db.prepare(
        `INSERT INTO memory_correction_requests(
          correction_id,lane_id,candidate_id,control_request_id,control_receipt_id,control_command_digest,
          provider_instance_id,request_id,request_digest,envelope_digest,idempotency_key,delegation_id,
          delegation_digest,target_manifest_digest,scope_digest,payload_digest,tombstone_sequence,
          tombstone_set_root,spool_locator,spool_digest,state,dispatch_fence,expires_at,created_at,updated_at
         ) VALUES('correction:concurrent',?,'candidate','control','receipt',?,'provider',
          'request',?,?,?,?,?,?,?,?,1,?,'request.json',?,'approved',0,?,?,?)`,
      ).run(`memcorr:req:v1:${"2".repeat(64)}`, digest, digest, digest,
        `memeff:idem:v2:${"3".repeat(64)}`, `memdeleg:v1:${"4".repeat(64)}`,
        digest, digest, digest, digest, digest, digest,
        "2026-08-31T00:10:00.000Z", NOW.toISOString(), NOW.toISOString());
      db.db.prepare(
        "UPDATE memory_correction_requests SET state='queued' WHERE correction_id='correction:concurrent'",
      ).run();
      db.db.pragma("foreign_keys=ON");
      const store = new MemoryCorrectionStore(db);
      const rows = await Promise.all(Array.from({ length: 32 }, async () =>
        store.beginDispatch("correction:concurrent", NOW)));
      expect(rows.every(row => row.dispatch_fence === 1 && row.state === "dispatching")).toBe(true);
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_correction_attempts").get())
        .toEqual({ count: 1 });
    } finally { db.close(); }
  });
});
