import { afterEach, describe, expect, it } from "vitest";
import { hasSecondBrainWriteAuthority } from "../../src/second-brain-write-authority.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, outboxFixture, type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";
const fixtures: OutboxFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) closeMemoryDatabase(fixture.database); });
describe("memory outbox complete authority binding", () => {
  it("opens post-marker write authority only for the exact accepted-unsettled projection", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); const queued = fixture.service.enqueue(claimAction(fixture));
    const store = Object.getOwnPropertyDescriptor(fixture.service, "store")?.value as {
      claimDispatch(worker: string, now: Date, lease: number): { outbox_id: string; lease_fence: number };
      markDispatch(id: string, worker: string, fence: number, now: Date): object;
    };
    expect(hasSecondBrainWriteAuthority(fixture.database.authority, fixture.request, fixture.clock.now)).toBe(false);
    const claimed = store.claimDispatch("authority-worker", fixture.clock.now, 10_000);
    store.markDispatch(claimed.outbox_id, "authority-worker", claimed.lease_fence, fixture.clock.now);
    expect(fixture.database.authority.db.prepare("SELECT state FROM memory_candidates WHERE candidate_id=?")
      .get(queued.candidate_id)).toEqual({ state: "accepted_unsettled" });
    expect(hasSecondBrainWriteAuthority(fixture.database.authority, fixture.request, fixture.clock.now)).toBe(true);
    fixture.database.authority.db.exec("DROP TRIGGER memory_candidates_transition");
    fixture.database.authority.db.prepare("UPDATE memory_candidates SET state='delivering' WHERE candidate_id=?")
      .run(queued.candidate_id);
    expect(hasSecondBrainWriteAuthority(fixture.database.authority, fixture.request, fixture.clock.now)).toBe(false);
  });
  it("rejects at least twenty forged authority classes with zero frames", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); const original = claimAction(fixture);
    const mutations: Array<(value: typeof original) => void> = [
      value => { value.action = "state.project"; }, value => { value.action_level = 2; },
      value => { value.target.candidate_id = "wrong"; }, value => { value.target.candidate_digest = "wrong"; },
      value => { value.target.classification_digest = "wrong"; }, value => { value.args.schema_version = 1; },
      value => { value.args.extra = true; }, value => { (value.args.expected_artifact as Record<string, unknown>).page_id = "../x"; },
      value => { (value.args.expected_artifact as Record<string, unknown>).sid = "bad"; },
      value => { (value.args.expected_artifact as Record<string, unknown>).source_digest = "bad"; },
      value => { value.args.dispatch_spool_digest = `sha256:${"0".repeat(64)}`; },
      value => { (value.args.expected_artifact as Record<string, unknown>).extra = true; },
      value => { (value.args.expected_artifact as Record<string, unknown>).page_id = ""; },
      value => { (value.args.expected_artifact as Record<string, unknown>).sid = "1"; },
      value => { (value.args.expected_artifact as Record<string, unknown>).source_digest = ""; },
      value => { value.args.schema_version = 3; },
      value => { value.args.dispatch_spool_digest = ""; },
      value => { Object.assign(value.args, { expected_artifact: null }); },
      value => { Object.assign(value.args, { expected_artifact: { page_id: "wiki/example-alpha" } }); },
      value => { Object.assign(value.args, { request: fixture.request }); },
      value => { value.target.candidate_digest = ""; },
      value => { value.target.classification_digest = ""; },
    ];
    for (const mutate of mutations) { const changed = structuredClone(original); mutate(changed); expect(() => fixture.service.enqueue(changed)).toThrow(); }
    expect(mutations.length).toBeGreaterThanOrEqual(20); expect(fixture.writer.calls).toHaveLength(0);
  });
  it("rejects legacy inline content even when candidate identities remain unchanged", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); const command = claimAction(fixture);
    const args = structuredClone(command.args) as Record<string, unknown>;
    args.request = fixture.request; command.args = args;
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
