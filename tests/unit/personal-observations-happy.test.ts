import { describe, expect, it } from "vitest";
import { normalizePersonalObservations, parseObservationEnvelopeV1 } from "../../src/index.js";
import { observationInput } from "../fixtures/personal-observation-input.js";

describe("Task 14 happy observation aggregation", () => {
  it("normalizes local and jm-server task evidence plus signed portfolio reports", () => {
    // Given: two structured active tasks and authenticated host projections.
    const input = observationInput();
    // When: every result is checked at the public contract boundary.
    const parsed = normalizePersonalObservations(input).map(parseObservationEnvelopeV1);
    // Then: explicit host/environment/task identities and structured references survive.
    expect(parsed).toHaveLength(4);
    expect(parsed.map(item => item.payload.kind)).toEqual(["live_task", "live_task", "portfolio", "portfolio"]);
    expect(parsed[0]).toMatchObject({ source: { host_id: "host:pos:linux-control-plane" }, payload: { value: { environment: "local", terminal_id: "terminal-local", incarnation_id: "incarnation-local", cursor: "cursor-local", task_id: "task-local", decision_ids: ["decision-local"], evidence_refs: ["receipt-local", "verify-local"] } } });
    expect(parsed[1]).toMatchObject({ source: { host_id: "host:pos:linux-control-plane" }, payload: { value: { environment: "jm-server", terminal_id: "terminal-jm-server", task_id: "task-jm-server" } } });
    expect(parsed[2]?.payload.value).toMatchObject({ environment: "local", active_task_count: 5 });
    expect(parsed[3]?.payload.value).toMatchObject({ environment: "jm-server", active_task_count: 1 });
  });

  it("drops timeline prose and payload bodies from normalized values", () => {
    // Given: structured events whose unused display fields contain private prose.
    const input = observationInput();
    // When: observations are normalized.
    const serialized = JSON.stringify(normalizePersonalObservations(input));
    // Then: only identifiers and evidence references remain.
    expect(serialized).not.toContain("not persisted");
    expect(serialized).not.toContain("body");
    expect(serialized).not.toContain("token");
  });
});
