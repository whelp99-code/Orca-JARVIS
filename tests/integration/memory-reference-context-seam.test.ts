import { afterEach, expect, it } from "vitest";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { prepareMemoryReference } from "../../src/memory-reference-context.js";
import { recordCandidateTaskSource } from "../../src/memory-candidate-task-source.js";
import { contextMemoryFromReference, ownerConfirmedContent } from "../../src/personal-memory-reference-evidence.js";
import { MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, evidence, FixtureReader, OUTBOX_ARTIFACT_DIGEST, outboxFixture,
  type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";
import { REFERENCE_GENERATION, REFERENCE_RECORD } from "../fixtures/memory-reference-provider.js";

const TASK = "task:reference-seam";
const NOW = new Date(MEMORY_NOW);
const BUDGETS = { max_records: 8, max_record_bytes: 4096, max_bytes: 16384 };
const databases: MemoryDatabase[] = [];
const fixtures: OutboxFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) closeMemoryDatabase(fixture.database);
  for (const database of databases.splice(0)) closeMemoryDatabase(database);
});

/**
 * A reference carrying one bound record, built by the product's own builder - the same payload the
 * reader returns, so what is exercised below is the consumption of a real return contract rather
 * than a shape invented here.
 */
function reference() {
  const bound = { ...evidence(OUTBOX_ARTIFACT_DIGEST),
    record: { ...REFERENCE_RECORD, generation: REFERENCE_GENERATION } };
  const prepared = prepareMemoryReference({ query: "example", budgets: BUDGETS, now: NOW,
    outcome: { kind: "current", checked_at: MEMORY_NOW, fresh_until: "2026-08-28T13:00:00.000Z",
      evidence: [bound] } as never });
  expect(prepared.payload.records).toHaveLength(1);
  // The contract states what it is, and every case below rests on that.
  expect(prepared.payload.trust).toBe("untrusted");
  expect(prepared.payload.authority).toBe("none");
  return prepared;
}

/** One write of ours, dispatched and settled through the real saga. */
async function settledWrite() {
  const fixture = await outboxFixture({ reader: new FixtureReader({ kind: "current",
    checked_at: "2026-08-28T12:00:00.000Z", evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)] }) });
  fixtures.push(fixture);
  const queued = fixture.service.enqueue(claimAction(fixture));
  expect(await fixture.service.runOnce("worker-one", 1)).toMatchObject({ settled: 1 });
  const row = fixture.database.authority.db.prepare(
    "SELECT state,expected_page_id,expected_sid FROM memory_outbox WHERE outbox_id=?").get(queued.outbox_id) as
    { state: string; expected_page_id: string; expected_sid: string };
  expect(row.state).toBe("settled");
  // The record the reference carries comes back on exactly the page and section this write landed on.
  expect([row.expected_page_id, row.expected_sid]).toEqual([evidence(OUTBOX_ARTIFACT_DIGEST).page_id, "12345678"]);
  return { fixture, authority: fixture.database.authority, candidateId: queued.candidate_id };
}

// Nothing of ours was ever written to that page, so the database cannot name what came back and the
// record contributes nothing at all.
it("contributes nothing when no settled write of ours landed on the page a record came back on", async () => {
  const database = await memoryDatabase();
  databases.push(database);
  const memories = contextMemoryFromReference(database.authority, reference());
  expect(memories).toEqual([{ kind: "gap", memory_ref: REFERENCE_RECORD.record_id, state: "no_data" }]);
});

// Naming it is not permission to use it. The write was approved, which is why it settled at all, and
// the owner still never confirmed this content as a principle - the candidate behind it required no
// confirmation and carries none - so it stays a gap.
it("refuses a record from a settled write the owner never confirmed as a principle", async () => {
  const settled = await settledWrite();
  const candidate = settled.authority.db.prepare(
    "SELECT required_confirmation,confirmation_receipt_id,content_digest FROM memory_candidates WHERE candidate_id=?")
    .get(settled.candidateId) as { required_confirmation: number; confirmation_receipt_id: string | null; content_digest: string };
  expect(candidate.required_confirmation).toBe(0);
  expect(candidate.confirmation_receipt_id).toBeNull();
  expect(ownerConfirmedContent(settled.authority, candidate.content_digest)).toBe(false);

  expect(contextMemoryFromReference(settled.authority, reference()))
    .toEqual([{ kind: "gap", memory_ref: REFERENCE_RECORD.record_id, state: "no_data" }]);
});

// The same returned record, the same database, and one act by the owner between them: hiding the task
// the candidate came from. The answer changes and says which of the two closed doors it is.
it("answers differently for the same record once the owner hides the task behind that write", async () => {
  const settled = await settledWrite();
  recordCandidateTaskSource(settled.authority, settled.candidateId, TASK, NOW);
  expect(contextMemoryFromReference(settled.authority, reference())[0])
    .toEqual({ kind: "gap", memory_ref: REFERENCE_RECORD.record_id, state: "no_data" });

  new MemoryProjectionAuthority(settled.authority)
    .quarantineUnresolved({ kind: "task_timeline", id: TASK, component_id: TASK }, NOW);

  expect(contextMemoryFromReference(settled.authority, reference())[0])
    .toEqual({ kind: "gap", memory_ref: REFERENCE_RECORD.record_id, state: "unavailable" });
});
