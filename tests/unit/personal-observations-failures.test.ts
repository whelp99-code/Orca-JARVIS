import { describe, expect, it } from "vitest";
import { normalizePersonalObservations, PersonalObservationNormalizationError } from "../../src/index.js";
import { signPortfolioEnvelope } from "../../src/dashboard/portfolio-auth.js";
import { localReport } from "../fixtures/portfolio-report.js";
import { OBSERVATION_CHECKED_AT, OBSERVATION_KEY, observationInput, observationTask } from "../fixtures/personal-observation-input.js";

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrowError(PersonalObservationNormalizationError);
  expect(action).toThrow(expect.objectContaining({ code }));
}

describe("Task 14 fail-closed observation matrix", () => {
  it("rejects an ambiguous structured terminal identity", () => {
    // Given: the same terminal identity appears twice in one source incarnation.
    const task = observationTask();
    const input = { ...observationInput(), portfolios: [], orca_tasks: [task, task] };
    // When/Then: normalization rejects rather than choosing one task.
    expectCode(() => normalizePersonalObservations(input), "PERSONAL_OBSERVATION_AMBIGUOUS_TERMINAL");
  });

  it("rejects a stale incarnation for one terminal", () => {
    // Given: one terminal is represented by conflicting incarnations.
    const task = observationTask();
    const input = { ...observationInput(), portfolios: [], orca_tasks: [task, { ...task, incarnation_id: "incarnation-stale" }] };
    // When/Then: stale identity cannot advance the cursor.
    expectCode(() => normalizePersonalObservations(input), "PERSONAL_OBSERVATION_STALE_INCARNATION");
  });

  it("rejects out-of-order authenticated portfolio reports", () => {
    // Given: a newer signed report precedes an older report for the same environment.
    const signed = (reported_at: string) => Buffer.from(JSON.stringify(signPortfolioEnvelope(localReport({ reported_at }), OBSERVATION_KEY)));
    const input = { checked_at: OBSERVATION_CHECKED_AT, orca_tasks: [], portfolios: [
      { environment: "local" as const, envelope: signed("2026-08-28T11:59:00.000Z"), received_at: OBSERVATION_CHECKED_AT, key: OBSERVATION_KEY },
      { environment: "local" as const, envelope: signed("2026-08-28T11:58:00.000Z"), received_at: OBSERVATION_CHECKED_AT, key: OBSERVATION_KEY },
    ] };
    // When/Then: ordering rejects before persistence.
    expectCode(() => normalizePersonalObservations(input), "PERSONAL_OBSERVATION_OUT_OF_ORDER");
  });

  it("rejects done state without structured evidence", () => {
    // Given: completion is represented only by an evidence-free done label.
    const task = observationTask();
    const done = { ...task, working: false, timeline: { ...task.timeline, task: { ...task.timeline.task, state: "done" }, events: [] } };
    // When/Then: prose/status alone is not completion evidence.
    expectCode(() => normalizePersonalObservations({ ...observationInput(), portfolios: [], orca_tasks: [done] }), "PERSONAL_OBSERVATION_EVIDENCE_REQUIRED");
  });

  it("rejects a terminal identity reused across hosts", () => {
    // Given: local and remote records claim one physical terminal identity.
    const local = observationTask("local");
    const remote = { ...observationTask("jm-server"), worktree_id: local.worktree_id, terminal_id: local.terminal_id };
    // When/Then: host identity cannot collapse into one row.
    expectCode(() => normalizePersonalObservations({ ...observationInput(), portfolios: [], orca_tasks: [local, remote] }), "PERSONAL_OBSERVATION_HOST_COLLISION");
  });
});

describe("Task 14 private input rejection", () => {
  it("rejects raw terminal preview and secret-bearing fields", () => {
    // Given: otherwise structured task records carry forbidden raw fields.
    const previewInput = { ...observationInput(), portfolios: [], orca_tasks: [{ ...observationTask(), preview: "agent done" }] };
    const secretInput = { ...observationInput(), portfolios: [], orca_tasks: [{ ...observationTask(), access_token: "secret-value" }] };
    // When/Then: neither field can cross the normalization boundary.
    expectCode(() => normalizePersonalObservations(previewInput), "PERSONAL_OBSERVATION_PRIVATE_INPUT");
    expectCode(() => normalizePersonalObservations(secretInput), "PERSONAL_OBSERVATION_PRIVATE_INPUT");
  });
});
