import { describe, expect, it } from "vitest";
import { assemblePersonalContext } from "../../src/index.js";
import { contextAssemblerInput } from "../fixtures/context-assembler-input.js";

describe("Task 15 conflict and freshness accounting", () => {
  it("surfaces contradictory, stale, no-data, and unavailable sources without selection", () => {
    // Given: valid fresh evidence plus every critical non-selectable source outcome.
    const base = contextAssemblerInput();
    const observations = structuredClone(base["observations"]);
    const memories = structuredClone(base["memories"]);
    if (!Array.isArray(observations) || !Array.isArray(memories)) throw new TypeError("context fixtures required");
    const fresh = observations[0];
    if (typeof fresh !== "object" || fresh === null) throw new TypeError("observation fixture required");
    const stale = structuredClone(fresh);
    stale.id = String(stale.id).replace(/[0-9a-f]{12}$/, "111111111111");
    if (typeof stale.payload !== "object" || stale.payload === null
      || typeof stale.freshness !== "object" || stale.freshness === null) {
      throw new TypeError("observation fields required");
    }
    stale.payload.state = "stale";
    stale.freshness.state = "stale";
    const principle = memories[0];
    if (typeof principle !== "object" || principle === null) throw new TypeError("memory fixture required");
    const contradictory = {
      ...principle,
      memory_ref: "sid:priority:contradiction",
      digest: `sha256:${"b".repeat(64)}`,
      relation: "contradicts",
    };
    const input = {
      ...base,
      observations: [fresh, stale],
      memories: [principle, contradictory,
        { kind: "gap", memory_ref: "second-brain:empty", state: "no_data" },
        { kind: "gap", memory_ref: "second-brain:outage", state: "unavailable" }],
    };
    // When: the context is assembled.
    const snapshot = assemblePersonalContext(input);
    // Then: unsafe evidence is absent from selections and explicitly accounted for.
    expect(snapshot.payload.state).toBe("insufficient");
    expect(snapshot.policy_decision.decision).toBe("abstain");
    expect(snapshot.payload.included_memory_refs).toEqual(["sid:principle:customer-first"]);
    expect(snapshot.payload.excluded_refs).toEqual(expect.arrayContaining([
      String(stale.id), "sid:priority:contradiction", "second-brain:empty", "second-brain:outage",
    ]));
    expect(snapshot.payload.conflicts.some(item => item.startsWith("MEMORY_CONFLICT:"))).toBe(true);
    expect(snapshot.payload.omissions.some(item => item.startsWith("STALE_SOURCE:"))).toBe(true);
    expect(snapshot.payload.omissions.some(item => item.startsWith("NO_DATA:"))).toBe(true);
    expect(snapshot.payload.omissions.some(item => item.startsWith("SOURCE_UNAVAILABLE:"))).toBe(true);
  });
});
