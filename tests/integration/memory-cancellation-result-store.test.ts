import { expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { AuthorityDb } from "../../src/db.js";
import { MemoryCorrectionCancellationResultStore } from "../../src/memory-correction-cancellation-result-store.js";
import { cancellationResultFixture } from "../fixtures/memory-cancellation-result.js";

it("stores exact provider result and reopens without cursor advancement or body deletion", async () => {
  const f = await cancellationResultFixture();
  try {
    const store = new MemoryCorrectionCancellationResultStore(f.db, f.runtime.clock);
    expect(store.record(f.record.correction_id, f.result)).toEqual(f.result);
    expect(store.record(f.record.correction_id, f.result)).toEqual(f.result);
    const db = new AuthorityDb(f.database.path);
    try { expect(new MemoryCorrectionCancellationResultStore(db, f.runtime.clock).get(f.record.correction_id)).toEqual(f.result); }
    finally { db.close(); }
    expect(f.db.db.prepare("SELECT accepted_through_sequence,active_lane_id FROM memory_effect_dispatch_cursor").get())
      .toEqual({ accepted_through_sequence: 0, active_lane_id: null });
    expect(f.db.db.prepare("SELECT state FROM memory_correction_requests").get()).toEqual({ state: "queued" });
    expect(() => f.db.db.prepare("DELETE FROM memory_correction_cancellation_results").run()).toThrow("immutable");
    expect(() => f.db.db.prepare("UPDATE memory_correction_cancellation_results SET result_digest='bad'").run()).toThrow("immutable");
    expect(canonicalize(store.get(f.record.correction_id))).not.toContain(f.staged.content);
  } finally { await f.close(); }
});

it.each(["revoked", "release", "period", "unknown"] as const)("rejects untrusted provider key %s without result rows", async change => {
  const f = await cancellationResultFixture();
  try {
    if (change === "revoked") f.db.db.prepare("UPDATE memory_provider_proof_keys SET state='revoked'").run();
    const result = change === "release" ? f.signed({ ...f.body, provider_release_sha: "b".repeat(40) })
      : change === "period" ? f.signed({ ...f.body, completed_at: "2026-08-29T01:00:00.000Z" })
      : change === "unknown" ? f.signed({ ...f.body, signing_key_id: "unknown" }) : f.result;
    if (change === "period") f.setTime(new Date("2026-08-30T00:00:00.000Z"));
    expect(() => new MemoryCorrectionCancellationResultStore(f.db, f.runtime.clock).record(f.record.correction_id, result)).toThrow();
    expect(f.db.db.prepare("SELECT count(*) AS n FROM memory_correction_cancellation_results").get()).toEqual({ n: 0 });
  } finally { await f.close(); }
});

it("accepts expired signing/intent TTL history but rejects a later explicit provider revocation", async () => {
  const f = await cancellationResultFixture();
  try {
    f.setTime(new Date("2026-08-30T00:00:00.000Z"));
    f.db.db.prepare("UPDATE memory_effect_delegation_keys SET state='revoked'").run();
    const store = new MemoryCorrectionCancellationResultStore(f.db, f.runtime.clock);
    expect(store.record(f.record.correction_id, f.result)).toEqual(f.result);
    f.db.db.prepare("UPDATE memory_provider_proof_keys SET state='revoked'").run();
    expect(() => store.get(f.record.correction_id)).toThrow();
    expect(f.db.db.prepare("SELECT count(*) AS n FROM memory_correction_cancellation_results").get()).toEqual({ n: 1 });
  } finally { await f.close(); }
});

it("rejects mismatched result and conflicting valid result replay", async () => {
  const f = await cancellationResultFixture();
  try {
    const store = new MemoryCorrectionCancellationResultStore(f.db, f.runtime.clock);
    expect(() => store.record(f.record.correction_id, f.signed({ ...f.body, intent_id: "other" }))).toThrow();
    store.record(f.record.correction_id, f.result);
    expect(() => store.record(f.record.correction_id, f.signed({ ...f.body, result_vault_head: "b".repeat(40) })))
      .toThrow("MEMORY_CANCELLATION_RESULT_REPLAY_CONFLICT");
  } finally { await f.close(); }
});

it("replays independently of mutable preparation state", async () => {
  const f = await cancellationResultFixture();
  try {
    const store = new MemoryCorrectionCancellationResultStore(f.db, f.runtime.clock);
    store.record(f.record.correction_id, f.result);
    // Simulate the later absence of preparation metadata without weakening original admission.
    const originalPrepare = f.db.db.prepare.bind(f.db.db);
    const prepare = f.db.db.prepare;
    f.db.db.prepare = ((sql: string) => {
      if (sql.includes("FROM memory_effect_preparations")) throw new Error("preparation must not be needed to read receipt");
      return originalPrepare(sql);
    }) as typeof prepare;
    try { expect(store.get(f.record.correction_id)).toEqual(f.result); }
    finally { f.db.db.prepare = prepare; }
  } finally { await f.close(); }
});
