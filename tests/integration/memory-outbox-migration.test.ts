import { describe, expect, it } from "vitest";
import { initialized } from "../helpers.js";
describe("memory outbox V2 forward migration", () => {
  it("publishes V2 columns, one-attempt index, and guarded transitions", async () => {
    const db = await initialized();
    try {
      const columns = (db.db.prepare("PRAGMA table_info(memory_outbox)").all() as Array<{ name: string }>).map(row => row.name);
      expect(columns).toEqual(expect.arrayContaining(["schema_version", "action_request_id", "request_json", "dispatch_fence", "reconcile_deadline_at", "settlement_receipt_digest"]));
      const indexes = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_outbox_attempts'").all() as Array<{ name: string }>).map(row => row.name);
      expect(indexes).toContain("memory_outbox_v2_one_attempt");
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='039_memory_outbox_saga.sql'").get() as { n: number }).n).toBe(1);
    } finally { db.close(); }
  });
});
