import { describe, expect, it } from "vitest";
import { runRecoveryCrash } from "../fixtures/memory-remediation-crash.js";

const cases = (["correction", "deletion"] as const).flatMap(lane =>
  (["pending", "proved"] as const).map(status => ({ lane, status })));

describe("spent destructive transport after process death", () => {
  it.each(cases)("observes $lane/$status without another frame after accepted-before-persist SIGKILL", async input => {
    // Given: an actual adapter transport call was durably accepted, but JARVIS never received the return.
    // When: the subscribed parent SIGKILLs that process and invokes the built CLI handler in a separate process.
    const recovered = await runRecoveryCrash({ ...input, barrier: "provider_accepted_before_local_persistence" });
    if (!("original_request" in recovered)) throw new Error("POST_FRAME_RECEIPT_MISSING");
    // Then: statuses, not writes, recover the original identity under its original single redemption.
    expect({ frames: recovered.frames, effects: recovered.effects, attempts: recovered.attempt_rows,
      tombstones: recovered.tombstones, redemptions: recovered.redemption_rows.count })
      .toEqual({ frames: 1, effects: 1, attempts: 1, tombstones: 1, redemptions: 1 });
    expect(recovered.status_reads).toBeGreaterThan(0);
    const original = recovered.original_request;
    expect(recovered.rows).toMatchObject([{ state: input.status === "proved" ? "settled" : "reconciling",
      request_id: original.request_id, request_digest: original.request_digest,
      envelope_digest: original.envelope_digest, expires_at: original.expires_at,
      delegation_id: original.delegation.delegation_id, delegation_digest: original.delegation.delegation_digest,
      dispatch_fence: 1, tombstone_sequence: 1 }]);
    expect(original.delegation.signing_key_id).toBe("jarvis:fixture");
    expect(recovered.effect_rows.count).toBe(input.status === "proved" ? 1 : 0);
    expect(recovered.purges).toBe(input.status === "proved" ? 1 : 0);
    expect(recovered.accepted_through).toBe(input.status === "proved" ? 1 : 0);
    expect(recovered.reconciled_spools).toBe(input.status === "proved" ? 1 : 0);
  }, 30_000);
});
