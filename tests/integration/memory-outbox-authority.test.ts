import { afterEach, describe, expect, it } from "vitest";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, outboxFixture, type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";
const fixtures: OutboxFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) closeMemoryDatabase(fixture.database); });
describe("memory outbox complete authority binding", () => {
  it("rejects at least twenty forged authority classes with zero frames", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); const original = claimAction(fixture);
    const mutations: Array<(value: typeof original) => void> = [
      value => { value.action = "state.project"; }, value => { value.action_level = 2; },
      value => { value.target.candidate_id = "wrong"; }, value => { value.target.candidate_digest = "wrong"; },
      value => { value.target.classification_digest = "wrong"; }, value => { value.args.schema_version = 1; },
      value => { value.args.extra = true; }, value => { (value.args.expected_artifact as Record<string, unknown>).page_id = "../x"; },
      value => { (value.args.expected_artifact as Record<string, unknown>).sid = "bad"; },
      value => { (value.args.expected_artifact as Record<string, unknown>).source_digest = "bad"; },
      value => { (value.args.request as Record<string, unknown>).extra = true; },
      value => { (value.args.request as Record<string, unknown>).request_digest = `sha256:${"0".repeat(64)}`; },
      value => { (value.args.request as Record<string, unknown>).candidate_id = `memcand:pos:v1:${"0".repeat(64)}`; },
      value => { (value.args.request as Record<string, unknown>).candidate_digest = `sha256:${"0".repeat(64)}`; },
      value => { (value.args.request as Record<string, unknown>).classification_digest = `sha256:${"0".repeat(64)}`; },
      value => { (value.args.request as Record<string, unknown>).purpose = "data_erasure"; },
      value => { (value.args.request as Record<string, unknown>).sensitivity = "restricted"; },
      value => { (value.args.request as Record<string, unknown>).retention_days = 0; },
      value => { (value.args.request as Record<string, unknown>).expected_prior = {}; },
      value => { (value.args.request as Record<string, unknown>).expires_at = "2026-08-28T11:00:00.000Z"; },
      value => { ((value.args.request as Record<string, unknown>).payload as Record<string, unknown>).content = "forged"; },
    ];
    for (const mutate of mutations) { const changed = structuredClone(original); mutate(changed); expect(() => fixture.service.enqueue(changed)).toThrow(); }
    expect(mutations.length).toBeGreaterThanOrEqual(20); expect(fixture.writer.calls).toHaveLength(0);
  });
  it("rejects changed content even when candidate identities remain unchanged", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); const command = claimAction(fixture);
    const args = structuredClone(command.args) as Record<string, unknown>; const request = args.request as Record<string, unknown>;
    request.payload = { content: "changed" }; command.args = args;
    expect(() => fixture.service.enqueue(command)).toThrowError(/MEMORY_OUTBOX_INPUT_INVALID|MEMORY_OUTBOX_AUTHORITY_INVALID/);
    expect(fixture.writer.calls).toHaveLength(0);
  });

  it("rejects revoked action authority before a frame", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); const command = claimAction(fixture);
    fixture.database.authority.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
      .run(command.request_id, "test", fixture.clock.now.toISOString());
    expect(() => fixture.service.enqueue(command)).toThrowError(/MEMORY_OUTBOX_AUTHORITY_INVALID/);
    expect(fixture.writer.calls).toHaveLength(0);
  });
});
