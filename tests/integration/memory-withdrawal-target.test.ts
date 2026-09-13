import { afterEach, expect, it } from "vitest";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import {
  memoriesAwaitingTaskWithdrawal, recordCandidateTaskSource,
} from "../../src/memory-candidate-task-source.js";
import { MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { resolveSettledTarget, settleRememberWrite } from "../fixtures/memory-remember-settlement.js";

const TASK = "task:withdrawal-target";
const NOW = new Date(MEMORY_NOW);
const open: MemoryDatabase[] = [];
afterEach(() => { for (const database of open.splice(0)) closeMemoryDatabase(database); });

/**
 * The list of what a hidden task still has out there has to name what to take back.
 *
 * A null target means nothing reached the provider. When something did, the entry has to carry the
 * target identity a withdrawal would act on - and the only identity that links a candidate to the
 * target resolved for its write is the source identity the write itself carries, which is derived
 * from the candidate. Matching on content identity cannot work: the provider computes that over the
 * record text and this database computes its own content digest over the candidate material, so
 * they are different numbers and the join never fires.
 */
it("names the target a withdrawal would act on once the write really reached the provider", async () => {
  const database = await memoryDatabase();
  open.push(database);
  const settled = await settleRememberWrite(database, { statement: "WithdrawalStatement",
    idempotency_key: "candidate:withdrawal", receipt_prefix: "withdrawal" });
  await resolveSettledTarget(database.authority, settled.page, NOW);
  recordCandidateTaskSource(database.authority, settled.candidate.candidate_id, TASK, NOW);

  // Nothing is outstanding while the task is visible.
  expect(memoriesAwaitingTaskWithdrawal(database.authority)).toEqual([]);

  new MemoryProjectionAuthority(database.authority)
    .quarantineUnresolved({ kind: "task_timeline", id: TASK, component_id: TASK }, NOW);

  const outstanding = memoriesAwaitingTaskWithdrawal(database.authority);
  expect(outstanding).toHaveLength(1);
  expect(outstanding[0]).toMatchObject({ candidate_id: settled.candidate.candidate_id, task_id: TASK });
  expect(String(outstanding[0]?.target_id)).toMatch(/^sbtarget:v1:[0-9a-f]{64}$/);
  expect(String(outstanding[0]?.target_digest)).toMatch(/^sha256:[0-9a-f]{64}$/);
}, 60_000);
