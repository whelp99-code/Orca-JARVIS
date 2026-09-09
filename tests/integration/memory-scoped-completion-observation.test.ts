import { expect, it } from "vitest";
import { scopedOutboxFixture } from "../fixtures/scoped-outbox.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { registerMemoryScopedOutbox } from "../../src/memory-scoped-outbox.js";
import { claimMemoryScopedOutbox, markMemoryScopedOutboxDispatch, recoverMemoryScopedOutboxDispatches } from "../../src/memory-scoped-outbox-worker.js";
import { observeMemoryScopedCompletion } from "../../src/memory-scoped-completion-observation.js";
import { claimMemoryScopedReconciliation } from "../../src/memory-scoped-reconciliation.js";

import { memoryHash } from "../../src/memory-candidate-values.js";

async function setup() {
  const f = await scopedOutboxFixture();
  const r = registerMemoryScopedOutbox(f.options, f.claimed), options = { ...f.options, roots: f.dispatch.roots };
  const lease = claimMemoryScopedOutbox(options, r.outbox_id, "worker:fixture", 1000)!;
  const dispatch = markMemoryScopedOutboxDispatch(options, lease, 30000), request = dispatch.request;
  const accepted_at = f.now.toISOString();
  const accepted = { schema_version: 4, kind: "accepted", state: "pending", provider_instance_id: request.provider_instance_id,
    request_id: request.request_id, request_digest: request.request_digest, idempotency_key: request.idempotency_key,
    scope_digest: request.preparation.binding.identity_digest, accepted_at, inbox_path: `pending/${request.request_id}.v4.json`,
    request_file_digest: memoryHash("second-brain/inbox-write-request/v4\0", { schema_version: 4, state: "pending", accepted_at, request }), replayed: false };
  return { ...f, dispatch, accepted };
}

it.each(["valid", "revoked", "stale", "shortened", "insert_failure"])("records scoped observation atomically: %s", async mode => {
  const f = await setup();
  try {
    const at = new Date(f.now.getTime() + 60000), db = f.database.authority.db;
    recoverMemoryScopedOutboxDispatches(f.database.authority, at);
    const options = f.options;
    const leased = claimMemoryScopedReconciliation(options, f.dispatch.outbox_id, "worker:observe", at, 10000)!;
    let checks = 0;
    // Trusted client port stub tests transaction failures; real MCP acceptance
    // exercises provider/status/artifact validation in the separate process gate.
    const value = { kind: "remembered_completion_observed", request_id: f.dispatch.request.request_id,
      request_digest: f.dispatch.request.request_digest, status: { acceptance: f.accepted, state: "proved" },
      artifact: { kind: "remembered_artifact_observed", digest: "fixture" },
      checked_at: at.toISOString(), valid_until: new Date(at.getTime() + 5000).toISOString() };
    const client = { withRememberedCompletion: async (_request: unknown, consume: any) => consume(value, () => {
      checks++;
      if (checks === 2 && mode === "revoked") throw new Error("revoked");
      if (checks === 2 && mode === "stale") db.prepare("UPDATE memory_outbox SET lease_owner='worker:other'").run();
      return { ...value, valid_until: new Date(at.getTime() + (checks === 2 && mode === "shortened" ? 1000 : 5000)).toISOString() };
    }) };
    if (mode === "insert_failure") db.exec("CREATE TEMP TRIGGER injected_observation_failure BEFORE INSERT ON memory_scoped_completion_observations BEGIN SELECT RAISE(ABORT,'injected'); END");
    if (mode === "valid") {
      const first = await observeMemoryScopedCompletion(options, leased.lease, client, () => at);
      expect(first.replayed).toBe(false);
      const row = db.prepare("SELECT * FROM memory_scoped_completion_observations").get() as Record<string, unknown>;
      expect(JSON.stringify(row)).not.toContain(f.dispatch.request.preparation.payload.content);
      checks = 0;
      expect(await observeMemoryScopedCompletion(options, leased.lease, client, () => at)).toEqual({ ...first, replayed: true });
      expect(() => db.prepare("UPDATE memory_scoped_completion_observations SET evidence_json='{}'").run()).toThrow("immutable");
      expect(() => db.prepare("DELETE FROM memory_scoped_completion_observations").run()).toThrow("immutable");
      expect(() => db.prepare("INSERT OR REPLACE INTO memory_scoped_completion_observations SELECT * FROM memory_scoped_completion_observations").run()).toThrow();
      value.artifact.digest = "changed";
      await expect(observeMemoryScopedCompletion(options, leased.lease, client, () => at)).rejects.toThrow("SCOPED_COMPLETION_OBSERVATION_CONFLICT");
      expect(db.prepare("SELECT count(*) AS n FROM memory_scoped_completion_observations").get()).toEqual({ n: 1 });
    } else {
      await expect(observeMemoryScopedCompletion(options, leased.lease, client, () => at)).rejects.toThrow();
      expect(db.prepare("SELECT count(*) AS n FROM memory_scoped_completion_observations").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT accepted_result_json FROM memory_outbox_attempts").get()).toEqual({ accepted_result_json: null });
      expect(db.prepare("SELECT count(*) AS n FROM memory_reconciliation_events WHERE event_type='provider_accepted'").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT lease_owner FROM memory_outbox").get()).toEqual({ lease_owner: "worker:observe" });
    }
    expect(db.prepare("SELECT state FROM memory_outbox").get()).toEqual({ state: "reconciling" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { closeMemoryDatabase(f.database); }
});
