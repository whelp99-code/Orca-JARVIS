import { describe, expect, it } from "vitest";
import { assemblePersonalContext, canonicalPersonalContractJson, normalizePersonalObservations } from "../../src/index.js";
import { parseContextAssemblerInput } from "../../src/context-assembler-input.js";
import { contextAssemblerInput } from "../fixtures/context-assembler-input.js";
import { observationTask } from "../fixtures/personal-observation-input.js";

const UNVERIFIED = ["user_confirmed", "inferred", "untrusted"] as const;
function fixture() {
  const input = parseContextAssemblerInput(contextAssemblerInput());
  const observation = input.observations[0];
  if (observation === undefined) throw new Error("live observation fixture required");
  return { input, observation };
}
describe("context assembler live observation trust", () => {
  it.each(UNVERIFIED)("excludes %s live evidence and accounts for the missing verified source", trust => {
    const { input, observation } = fixture();
    const snapshot = assemblePersonalContext({ ...input,
      observations: [{ ...observation, payload: { ...observation.payload, trust } }] });
    expect(snapshot.payload.state).toBe("insufficient");
    expect(snapshot.policy_decision.decision).toBe("abstain");
    expect(snapshot.payload.included_observation_refs).toEqual([]);
    expect(snapshot.payload.excluded_refs).toEqual([observation.id]);
    expect(snapshot.evidence.map(item => item.kind)).toEqual(["confirmed_memory"]);
    expect(snapshot.payload.omissions).toEqual([
      expect.stringMatching(/^LIVE_LINUX_REQUIRED:[0-9a-f]{8}$/),
      expect.stringMatching(/^UNVERIFIED_SOURCE:[0-9a-f]{8}$/),
    ]);
  });

  it.each(UNVERIFIED)("keeps a critical %s omission when another verified observation exists", trust => {
    const { input, observation } = fixture();
    const other = { ...observation, id: observation.id.replace(/[0-9a-f]{12}$/, "111111111111"),
      payload: { ...observation.payload, trust } };
    const source = { ...input, observations: [other, observation] };
    const snapshot = assemblePersonalContext(source);
    expect(snapshot.payload.state).toBe("insufficient");
    expect(snapshot.policy_decision.decision).toBe("abstain");
    expect(snapshot.payload.included_observation_refs).toEqual([observation.id]);
    expect(snapshot.payload.excluded_refs).toEqual([other.id]);
    expect(snapshot.evidence).toEqual(assemblePersonalContext(input).evidence);
    expect(snapshot.payload.omissions).toEqual([expect.stringMatching(/^UNVERIFIED_SOURCE:[0-9a-f]{8}$/)]);
    expect(canonicalPersonalContractJson(assemblePersonalContext({ ...source,
      observations: [observation, other] }))).toBe(canonicalPersonalContractJson(snapshot));
  });

  it.each(["inferred", "untrusted"] as const)("still excludes %s memory alongside verified live work", trust => {
    const { input, observation } = fixture();
    const snapshot = assemblePersonalContext({ ...input,
      memories: input.memories.map(item => item.kind === "evidence" ? { ...item, trust } : item) });
    expect(snapshot.payload.state).toBe("insufficient");
    expect(snapshot.payload.included_memory_refs).toEqual([]);
    expect(snapshot.payload.included_observation_refs).toEqual([observation.id]);
    expect(snapshot.evidence.map(item => item.kind)).toEqual(["context_observation"]);
    expect(snapshot.payload.omissions.some(item => item.startsWith("UNCONFIRMED_MEMORY:"))).toBe(true);
  });

  it("preserves stale and non-task classification precedence", () => {
    const { input, observation } = fixture();
    const stale = assemblePersonalContext({ ...input, observations: [{ ...observation,
      payload: { ...observation.payload, trust: "untrusted", state: "stale" } }] });
    expect(stale.payload.omissions.some(item => item.startsWith("STALE_SOURCE:"))).toBe(true);
    expect(stale.payload.omissions.some(item => item.startsWith("UNVERIFIED_SOURCE:"))).toBe(false);
    const nonTask = assemblePersonalContext({ ...input, observations: [{ ...observation,
      payload: { ...observation.payload, trust: "untrusted", kind: "status" } }] });
    expect(nonTask.payload.omissions.some(item => item.startsWith("NON_LINUX_LIVE:"))).toBe(true);
    expect(nonTask.payload.omissions.some(item => item.startsWith("UNVERIFIED_SOURCE:"))).toBe(false);
  });

  it("classifies fresh payload with expired freshness as stale before checking trust", () => {
    const { input, observation } = fixture();
    const snapshot = assemblePersonalContext({ ...input, clock: observation.freshness.fresh_until,
      observations: [{ ...observation, payload: { ...observation.payload, trust: "untrusted" } }] });
    expect(snapshot.payload.included_observation_refs).toEqual([]);
    expect(snapshot.payload.omissions.some(item => item.startsWith("STALE_SOURCE:"))).toBe(true);
    expect(snapshot.payload.omissions.some(item => item.startsWith("UNVERIFIED_SOURCE:"))).toBe(false);
  });

  it("classifies Mac observations as non-Linux before checking trust", () => {
    const { input } = fixture();
    const mac = normalizePersonalObservations({ checked_at: input.clock,
      orca_tasks: [observationTask("mac-client")], portfolios: [] });
    const snapshot = assemblePersonalContext({ ...input,
      observations: mac.map(item => ({ ...item, payload: { ...item.payload, trust: "untrusted" } })) });
    expect(snapshot.payload.included_observation_refs).toEqual([]);
    expect(snapshot.payload.omissions.some(item => item.startsWith("NON_LINUX_LIVE:"))).toBe(true);
    expect(snapshot.payload.omissions.some(item => item.startsWith("UNVERIFIED_SOURCE:"))).toBe(false);
  });
});
