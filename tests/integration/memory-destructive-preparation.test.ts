import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Jarvis from "../../src/index.js";
import { AuthorityDb } from "../../src/db.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import { tempDb } from "../helpers.js";

const request = ((JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  readonly vectors: { readonly correction: { readonly request: MemoryEffectWriteRequestV2 } };
}).vectors.correction.request);
function fixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("MEMORY_FIXTURE_INVALID");
  return value;
}
const delta = fixture(request.tombstone_chain_delta[0]);

type PreparedIdentity = {
  readonly request_id: string;
  readonly request_digest: string;
  readonly envelope_digest: string;
  readonly idempotency_key: string;
  readonly delegation: { readonly delegation_id: string; readonly delegation_digest: string };
};
type PreparationResult = {
  readonly replayed: boolean;
  readonly request: PreparedIdentity;
  readonly entry: { readonly sequence: number; readonly effective_at: string };
  readonly current_global_high_water: { readonly sequence: number; readonly set_root: string };
};
type PreparationStore = {
  prepare(input: {
    readonly lane_id: string;
    readonly provider_high_water: { readonly sequence: number; readonly set_root: string };
    readonly tombstone: {
      readonly operation: "correct";
      readonly lane_id: string;
      readonly targets: MemoryEffectWriteRequestV2["targets"];
      readonly target_manifest_digest: string;
      readonly scope_digest: string;
      readonly authority_receipt_digest: string;
      readonly payload_digest: string;
      readonly effective_at: string;
    };
    readonly build_request: (value: {
      readonly high_water: { readonly sequence: number; readonly set_root: string };
      readonly chain_delta: readonly unknown[];
    }) => PreparedIdentity;
    readonly materialize: (request: PreparedIdentity, sequence: number) => void;
  }): PreparationResult;
};
type PreparationConstructor = new (
  authority: AuthorityDb,
  subjectKey: Buffer,
) => PreparationStore;

function isPreparationConstructor(value: unknown): value is PreparationConstructor {
  return typeof value === "function";
}

function stage(db: AuthorityDb): void {
  db.db.prepare(
    `INSERT INTO memory_effect_preparations(
      lane_id,lane,operation,provider_instance_id,candidate_id,target_manifest_digest,scope_digest,
      payload_digest,spool_locator,spool_digest,state,expires_at,created_at,updated_at
     ) VALUES(?,'correction','correct','provider:fixture','candidate:test',?,?,?,?,?,'staged',?,?,?)`,
  ).run(request.lane_id, request.target_manifest_digest, request.scope_digest,
    request.delegation.payload_digest, "correction.json", `sha256:${"a".repeat(64)}`,
    request.expires_at, request.created_at, request.created_at);
}

function input(materialize: (value: PreparedIdentity, sequence: number) => void,
  effectiveAt = request.created_at): Parameters<PreparationStore["prepare"]>[0] {
  return {
    lane_id: request.lane_id,
    provider_high_water: { sequence: 0,
      set_root: "sha256:7fb694c8abb7c9a4477aa38381c49446493bc4da1c01b50690c1db5b2c20b9d3" },
    tombstone: { operation: "correct", lane_id: request.lane_id, targets: request.targets,
      target_manifest_digest: request.target_manifest_digest, scope_digest: request.scope_digest,
      authority_receipt_digest: delta.authority_receipt_digest,
      payload_digest: request.delegation.payload_digest, effective_at: effectiveAt },
    build_request: () => request,
    materialize,
  };
}

describe("atomic destructive effect preparation", () => {
  it("rolls back chain and suppression when lane materialization fails", async () => {
    // Given: a staged correction and a materializer that fails at the final transaction write.
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      stage(db);
      db.db.exec("CREATE TABLE task30_atomic_probe(sequence INTEGER PRIMARY KEY)");
      const constructor = Reflect.get(Jarvis, "MemoryDestructivePreparationStore");
      expect(isPreparationConstructor(constructor)).toBe(true);
      if (!isPreparationConstructor(constructor)) return;
      const store = new constructor(db, Buffer.alloc(32, 4));

      // When: preparation reaches lane materialization and the transaction aborts.
      expect(() => store.prepare(input(() => {
        throw new Error("injected materialization failure");
      }))).toThrow("injected materialization failure");

      // Then: no orphan chain, suppression, link, request identity, or lane row is durable.
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_tombstone_chain").get()).toEqual({ count: 0 });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_suppressions").get()).toEqual({ count: 0 });
      expect(db.db.prepare(
        "SELECT state,request_id,effective_at FROM memory_effect_preparations WHERE lane_id=?",
      ).get(request.lane_id)).toEqual({ state: "staged", request_id: null, effective_at: null });
    } finally { db.close(); }
  });

  it("replays original wire identity and exposes the current global high-water", async () => {
    // Given: one successful atomic preparation followed by another semantic tombstone.
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      stage(db);
      db.db.exec("CREATE TABLE task30_atomic_probe(sequence INTEGER PRIMARY KEY)");
      const constructor = Reflect.get(Jarvis, "MemoryDestructivePreparationStore");
      expect(isPreparationConstructor(constructor)).toBe(true);
      if (!isPreparationConstructor(constructor)) return;
      const store = new constructor(db, Buffer.alloc(32, 4));
      const first = store.prepare(input((_value, sequence) => {
        db.db.prepare("INSERT INTO task30_atomic_probe VALUES(?)").run(sequence);
      }));
      const chain = new Jarvis.MemoryTombstoneChain(db, Buffer.alloc(32, 4));
      const secondRequest = (JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
        readonly vectors: { readonly forget: { readonly request: MemoryEffectWriteRequestV2 } };
      }).vectors.forget.request;
      const secondDelta = secondRequest.tombstone_chain_delta.at(-1);
      if (secondDelta === undefined) throw new Error("MEMORY_FIXTURE_INVALID");
      const second = chain.append({ operation: "forget", lane_id: secondRequest.lane_id,
        targets: secondRequest.targets, target_manifest_digest: secondRequest.target_manifest_digest,
        scope_digest: secondRequest.scope_digest,
        authority_receipt_digest: secondDelta.authority_receipt_digest,
        payload_digest: secondRequest.delegation.payload_digest, effective_at: secondRequest.created_at });

      // When: the first semantic preparation retries with a later process clock.
      const replay = store.prepare(input(() => {
        throw new Error("replay must not rematerialize");
      }, "2026-08-31T00:00:00.001Z"));

      // Then: original request/effective time remain fixed and status reports sequence two.
      expect(first.replayed).toBe(false);
      expect(replay).toMatchObject({ replayed: true, request: {
        request_id: request.request_id, request_digest: request.request_digest,
      }, entry: { sequence: 1, effective_at: request.created_at },
      current_global_high_water: second.current_global_high_water });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM task30_atomic_probe").get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });
});
