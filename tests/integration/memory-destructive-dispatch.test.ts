import { describe, expect, it } from "vitest";
import * as Jarvis from "../../src/index.js";
import { AuthorityDb, JarvisError } from "../../src/db.js";
import { tempDb } from "../helpers.js";

type CursorClaim = {
  readonly kind: "claimed" | "reconcile";
  readonly fence: number;
  readonly lane_id: string;
  readonly sequence: number;
};
type Cursor = {
  claim(input: { readonly lane_id: string; readonly lane: "correction" | "deletion";
    readonly sequence: number; readonly request_digest: string }, now: Date): CursorClaim;
  accepted(laneId: string, now: Date): void;
};
type CursorConstructor = new (authority: AuthorityDb) => Cursor;

function isCursorConstructor(value: unknown): value is CursorConstructor {
  return typeof value === "function";
}

function seedPreparation(db: AuthorityDb, laneId: string, lane: "correction" | "deletion",
  operation: "correct" | "forget", sequence: number, requestDigest: string): void {
  const at = "2026-08-31T00:00:00.000Z";
  db.db.prepare(
    `INSERT INTO memory_effect_preparations(
      lane_id,lane,operation,provider_instance_id,target_manifest_digest,scope_digest,payload_digest,
      spool_locator,spool_digest,state,expires_at,created_at,updated_at,effective_at,
      provider_tombstone_sequence,provider_tombstone_set_root,request_tombstone_sequence,
      request_tombstone_set_root,request_id,request_digest,envelope_digest,provider_idempotency_key,
      delegation_id,delegation_digest,prepared_at
     ) VALUES(?,?,?,?,?,?,?,?,?,'approved',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(laneId, lane, operation, "provider:test", `sha256:${"1".repeat(64)}`,
    `sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`, `${laneId}.json`,
    `sha256:${String(sequence).repeat(64)}`, "2026-08-31T00:10:00.000Z", at, at, at,
    sequence - 1, sequence === 1 ? `sha256:${"7".repeat(64)}` : `sha256:${"8".repeat(64)}`,
    sequence, `sha256:${String(sequence + 3).repeat(64)}`,
    `memeff:req:v2:${String(sequence + 4).repeat(64)}`, requestDigest,
    `sha256:${String(sequence + 5).repeat(64)}`, `memeff:idem:v2:${String(sequence + 6).repeat(64)}`,
    `memdeleg:v1:${String(sequence + 7).repeat(64)}`, `sha256:${String(sequence + 8).repeat(64)}`, at);
}

describe("ordered destructive dispatch cursor", () => {
  it("blocks N+1 while N is uncertain and never spends a second fence for N", async () => {
    // Given: two prepared destructive effects with consecutive permanent chain sequences.
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const firstLane = `memcorr:req:v1:${"a".repeat(64)}`;
      const secondLane = `memdel:req:v1:${"b".repeat(64)}`;
      const firstDigest = `sha256:${"c".repeat(64)}`;
      const secondDigest = `sha256:${"d".repeat(64)}`;
      seedPreparation(db, firstLane, "correction", "correct", 1, firstDigest);
      seedPreparation(db, secondLane, "deletion", "forget", 2, secondDigest);
      const constructor = Reflect.get(Jarvis, "MemoryDestructiveDispatchCursor");
      expect(isCursorConstructor(constructor)).toBe(true);
      if (!isCursorConstructor(constructor)) return;
      const cursor = new constructor(db);
      const now = new Date("2026-08-31T00:00:01.000Z");

      // When: N+1 races first, N becomes active, and both effects retry under uncertainty.
      expect(() => cursor.claim({ lane_id: secondLane, lane: "deletion", sequence: 2,
        request_digest: secondDigest }, now)).toThrowError(expect.objectContaining<Partial<JarvisError>>({
          code: "MEMORY_DESTRUCTIVE_ORDER_BLOCKED",
        }));
      expect(cursor.claim({ lane_id: firstLane, lane: "correction", sequence: 1,
        request_digest: firstDigest }, now)).toMatchObject({ kind: "claimed", fence: 1 });
      expect(cursor.claim({ lane_id: firstLane, lane: "correction", sequence: 1,
        request_digest: firstDigest }, now)).toMatchObject({ kind: "reconcile", fence: 1 });
      expect(() => cursor.claim({ lane_id: secondLane, lane: "deletion", sequence: 2,
        request_digest: secondDigest }, now)).toThrowError(expect.objectContaining<Partial<JarvisError>>({
          code: "MEMORY_DESTRUCTIVE_ORDER_BLOCKED",
        }));

      // Then: provider durability for N advances once and only then admits N+1.
      cursor.accepted(firstLane, now);
      expect(cursor.claim({ lane_id: secondLane, lane: "deletion", sequence: 2,
        request_digest: secondDigest }, now)).toMatchObject({ kind: "claimed", fence: 2 });
      expect(db.db.prepare(
        "SELECT fence,active_sequence,accepted_through_sequence FROM memory_effect_dispatch_cursor",
      ).get()).toEqual({ fence: 2, active_sequence: 2, accepted_through_sequence: 1 });
    } finally { db.close(); }
  });
});
