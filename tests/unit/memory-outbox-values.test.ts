import { describe, expect, it } from "vitest";
import { MEMORY_OUTBOX_RUNTIME_DEADLINE_MS, MemoryOutboxService } from "../../src/index.js";
import { memoryObservationDigest, memoryOutboxHash, memorySettlementDigest } from "../../src/memory-outbox-values.js";
describe("memory outbox V2 values", () => {
  it("freezes domain-separated identities and the ten-minute runtime deadline", () => {
    expect(memoryOutboxHash("memory-outbox", { a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(memoryOutboxHash("memory-outbox", { a: 1 })).not.toBe(memoryOutboxHash("memory-outbox-audit", { a: 1 }));
    expect(MEMORY_OUTBOX_RUNTIME_DEADLINE_MS).toBe(600_000);
  });
  it("binds every exact observation and settlement preimage field", () => {
    const observation = { outbox_id: "outbox", attempt_id: "attempt", reconcile_fence: 3,
      page_id: "wiki/page", sid: "12345678", source_version: "version", source_digest: `sha256:${"1".repeat(64)}`,
      observed_at: "2026-08-31T03:30:00.000Z", outcome: "ARTIFACT_OBSERVED" };
    const observationDigest = memoryObservationDigest(observation);
    for (const key of Object.keys(observation) as Array<keyof typeof observation>) {
      const changed = { ...observation };
      Reflect.set(changed, key, typeof observation[key] === "number" ? 4 : `${observation[key]}-changed`);
      expect(memoryObservationDigest(changed), key).not.toBe(observationDigest);
    }
    const settlement = { outbox_id: "outbox", candidate_id: "candidate", candidate_digest: `sha256:${"2".repeat(64)}`,
      request_id: "request", request_digest: `sha256:${"3".repeat(64)}`, attempt_id: "attempt",
      invocation_digest: `sha256:${"4".repeat(64)}`, dispatch_fence: 3, acceptance_receipt_digest: `sha256:${"5".repeat(64)}`,
      page_id: "wiki/page", sid: "12345678", source_version: "version", source_digest: `sha256:${"6".repeat(64)}`,
      observation_digest: observationDigest, reconciled_at: "2026-08-31T03:30:00.000Z" };
    const settlementDigest = memorySettlementDigest(settlement);
    for (const key of Object.keys(settlement) as Array<keyof typeof settlement>) {
      const changed = { ...settlement };
      Reflect.set(changed, key, typeof settlement[key] === "number" ? 4 : `${settlement[key]}-changed`);
      expect(memorySettlementDigest(changed), key).not.toBe(settlementDigest);
    }
  });
  it("matches the frozen exact settlement receipt vector", () => {
    const frozen = { outbox_id: "outbox", candidate_id: "candidate", candidate_digest: `sha256:${"2".repeat(64)}`,
      request_id: "request", request_digest: `sha256:${"3".repeat(64)}`, attempt_id: "attempt",
      invocation_digest: `sha256:${"4".repeat(64)}`, dispatch_fence: 3,
      acceptance_receipt_digest: `sha256:${"5".repeat(64)}`, page_id: "wiki/page", sid: "12345678",
      source_version: "version", source_digest: `sha256:${"6".repeat(64)}`,
      observation_digest: `sha256:${"7".repeat(64)}`, reconciled_at: "2026-08-31T03:30:00.000Z" };
    expect(memorySettlementDigest(frozen)).toBe(
      "sha256:f187be2d3ed5a5804e3926718d5053e02d323b17eb51e552d3809183fc7f2a7e",
    );
  });
  it("rejects unbounded constructor durations", () => {
    const stub = {} as ConstructorParameters<typeof MemoryOutboxService>[0];
    expect(() => new MemoryOutboxService({ ...stub, leaseMs: 0 })).toThrow("MEMORY_OUTBOX_CONFIG_INVALID");
    expect(() => new MemoryOutboxService({ ...stub, artifactDeadlineMs: 600_001 })).toThrow("MEMORY_OUTBOX_CONFIG_INVALID");
  });
});
