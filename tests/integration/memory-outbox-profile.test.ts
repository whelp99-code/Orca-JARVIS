import { expect, it } from "vitest";
import { outboxFixture, claimAction } from "../fixtures/memory-outbox-fixture.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { MemoryOutboxRecordReader } from "../../src/memory-outbox-record.js";

it("defaults existing enqueue to legacy and prevents later profile reassignment", async () => {
  const f = await outboxFixture();
  try {
    const saga = f.service.enqueue(claimAction(f));
    const db = f.database.authority.db;
    expect(db.prepare("SELECT request_profile FROM memory_outbox WHERE outbox_id=?").get(saga.outbox_id)).toEqual({ request_profile: "legacy" });
    expect(() => db.prepare("UPDATE memory_outbox SET request_profile='scoped-v4' WHERE outbox_id=?").run(saga.outbox_id))
      .toThrow("immutable memory outbox request profile");
    expect(f.service.get(saga.outbox_id)).toEqual(saga);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { closeMemoryDatabase(f.database); }
});
it("keeps explicitly scoped rows out of legacy dispatch, reconstruction and list surfaces", async () => {
  const source = await outboxFixture(); const target = await outboxFixture();
  try {
    const original = source.service.enqueue(claimAction(source));
    const action = claimAction(target);
    const row = source.database.authority.db.prepare("SELECT * FROM memory_outbox WHERE outbox_id=?").get(original.outbox_id) as Record<string, any>;
    Object.assign(row, { request_profile: "scoped-v4", candidate_id: target.request.candidate_id,
      candidate_digest: target.request.candidate_digest, classification_digest: target.request.classification_digest,
      action_request_id: action.request_id, action_receipt_id: action.receipt_id, action_command_digest: action.command_digest,
      request_id: `memreq:scoped:v4:${"a".repeat(64)}`, request_digest: `sha256:${"a".repeat(64)}` });
    const keys = Object.keys(row);
    // Storage-routing fixture only: not a granted scoped write or signed V4 action.
    target.database.authority.db.prepare(`INSERT INTO memory_outbox(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`)
      .run(...keys.map(key => row[key]));
    const before = target.database.authority.db.prepare("SELECT * FROM memory_outbox").all();
    expect(target.service.list()).toEqual([]);
    expect(() => target.service.get(original.outbox_id)).toThrow("MEMORY_OUTBOX_PROFILE_UNSUPPORTED");
    expect(() => new MemoryOutboxRecordReader(target.database.authority).request(original.outbox_id, target.clock.now))
      .toThrow("MEMORY_OUTBOX_PROFILE_UNSUPPORTED");
    const result = await target.service.runOnce("legacy-worker");
    expect(result).toMatchObject({ claimed: 0, dispatched: 0, failed: 0, settled: 0 });
    expect(target.writer.calls).toHaveLength(0);
    expect(target.database.authority.db.prepare("SELECT * FROM memory_outbox").all()).toEqual(before);
    expect(target.database.authority.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { closeMemoryDatabase(source.database); closeMemoryDatabase(target.database); }
});
