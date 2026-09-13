import { expect, it } from "vitest";
import { rankPriorityActionsWithDeadlineEvidence } from "../../src/priority-engine.js";
import { priorityEngineInput, priorityPolicyConfig } from "../fixtures/priority-engine-input.js";

/**
 * The engine refuses an empty candidate list at its input boundary rather than ranking nothing.
 *
 * That is a reasonable thing for it to do - an engine asked to rank nothing has been called by
 * mistake - but it means a producer that derives no candidate must abstain before reaching it, or
 * the morning fails where the honest answer is "there is nothing to propose". This pins the boundary
 * so the producer's obligation stays visible: docs/daily-production-contract-2026-09-14.md records
 * which conditions make a run withhold, and every one of them is checked before this call.
 */
it("refuses an empty candidate list at the engine input boundary", () => {
  expect(() => rankPriorityActionsWithDeadlineEvidence(priorityPolicyConfig(),
    priorityEngineInput({ candidates: [] }))).toThrow();
});

/** The same boundary for principles, which an earlier change already turned into an abstention. */
it("refuses an empty principle list at the engine input boundary", () => {
  expect(() => rankPriorityActionsWithDeadlineEvidence(priorityPolicyConfig(),
    { ...priorityEngineInput(), principles: [] })).toThrow();
});
