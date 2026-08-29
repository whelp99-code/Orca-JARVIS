import { describe, expect, it } from "vitest";
import { normalizePersonalObservations, PersonalObservationNormalizationError } from "../../src/index.js";
import { signPortfolioEnvelope } from "../../src/dashboard/portfolio-auth.js";
import { localReport } from "../fixtures/portfolio-report.js";
import { OBSERVATION_CHECKED_AT, OBSERVATION_KEY, observationInput, observationTask } from "../fixtures/personal-observation-input.js";

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrowError(PersonalObservationNormalizationError);
  expect(action).toThrow(expect.objectContaining({ code }));
}
function normalizeUnknown(input: unknown): unknown {
  return Reflect.apply(normalizePersonalObservations, undefined, [input]);
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
    const previewInput = {
      ...observationInput(),
      portfolios: [],
      orca_tasks: [{ ...observationTask(), preview: "agent done" }],
    };
    const secretInput = {
      ...observationInput(),
      portfolios: [],
      orca_tasks: [{ ...observationTask(), access_token: "secret-value" }],
    };
    // When/Then: neither field can cross the normalization boundary.
    expectCode(() => normalizePersonalObservations(previewInput), "PERSONAL_OBSERVATION_PRIVATE_INPUT");
    expectCode(() => normalizePersonalObservations(secretInput), "PERSONAL_OBSERVATION_PRIVATE_INPUT");
  });

  it("does not return a secret-bearing evidence-reference value", () => {
    // Given: a timeline event references evidence with a secret-bearing source value.
    const task = observationTask();
    const event = task.timeline.events[0];
    if (event === undefined) throw new TypeError("event fixture required");
    const input = {
      ...observationInput(),
      portfolios: [],
      orca_tasks: [{ ...task, timeline: { ...task.timeline, events: [{ ...event, evidence_refs: ["token=super-secret"] }] } }],
    };
    // When: the public normalizer returns its envelope.
    const serialized = JSON.stringify(normalizePersonalObservations(input));
    // Then: only derived evidence identity may leave the boundary.
    expect(serialized).not.toContain("token=super-secret");
  });
});

const malformedInputs: readonly [string, unknown][] = [
  ["null input", null],
  ["missing arrays", { checked_at: OBSERVATION_CHECKED_AT }],
  ["wrong scalar types", { checked_at: 7, orca_tasks: [], portfolios: [] }],
  ["hostile extra keys", { ...observationInput(), hostile: true }],
  ["null task items", { ...observationInput(), portfolios: [], orca_tasks: [null] }],
];

describe("Task 14 malformed public input", () => {
  it.each(malformedInputs)("throws the typed input error for %s", (_name, input) => {
    // Given: malformed data crosses the exported runtime boundary.
    // When/Then: normalization emits only the typed Task 14 input error.
    expectCode(() => normalizeUnknown(input), "PERSONAL_OBSERVATION_INPUT_INVALID");
  });
});
