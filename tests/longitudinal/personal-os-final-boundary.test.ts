import { describe, expect, it } from "vitest";
import { loadPersonalOsCorpus } from "../../src/personal-os-eval-file.js";
import { runPersonalOsCorpus } from "../../src/personal-os-runner.js";
import { scorePersonalOsResults } from "../../src/personal-os-scorer.js";
import type { PersonalOsCorpus } from "../../src/personal-os-eval-types.js";

const root = new URL("../../test/fixtures/personal-os", import.meta.url).pathname;
const corpus = (): PersonalOsCorpus => loadPersonalOsCorpus("happy.json", root);
const invoke = (source: PersonalOsCorpus, traces: unknown): unknown => Reflect.apply(scorePersonalOsResults, undefined, [source, traces]);
const invalid = (source: PersonalOsCorpus, traces: unknown): void => {
  expect(() => invoke(source, traces)).toThrow("PERSONAL_OS_ACTUAL_TRACE_INVALID");
};

describe("Task 19 closed actual-trace boundary", () => {
  it("accepts runner output and rejects missing, extra, duplicate, unknown, and malformed values", () => {
    // Given: one valid runner trace set and independent closed-schema adversaries
    const source = corpus(); const traces = runPersonalOsCorpus(source); const first = traces[0];
    if (first === undefined) throw new TypeError("trace fixture missing");
    const cases: readonly unknown[] = [traces.slice(1), [...traces, first], [first, first, ...traces.slice(2)],
      [{ ...first, effect_events: ["unknown"] }, ...traces.slice(1)],
      [{ ...first, dependencies: { ...first.dependencies, gpu_calls: 0 } }, ...traces.slice(1)],
      [{ ...first, outcome: 1 }, ...traces.slice(1)], [{ ...first, selected_record_ids: ["same", "same"] }, ...traces.slice(1)],
      [{ ...first, schema_version: 2 }, ...traces.slice(1)], [{ ...first, extra: true }, ...traces.slice(1)], null];

    // When / Then: valid runner output scores and every malformed variant has one stable public error
    expect(invoke(source, traces)).toMatchObject({ verdict: "pass" });
    for (const malformed of cases) invalid(source, malformed);
  });

  it("rejects sparse, accessor, symbol, non-enumerable, and custom-prototype inputs without incidental errors", () => {
    // Given: hostile JavaScript object mechanics at every actual-trace container boundary
    const source = corpus(); const traces = runPersonalOsCorpus(source); const first = traces[0];
    if (first === undefined) throw new TypeError("trace fixture missing");
    const sparse: unknown[] = [...traces]; delete sparse[0];
    const accessor = { ...first }; Object.defineProperty(accessor, "reason_code", { enumerable: true, get: () => "ANSWERED" });
    const symbol = { ...first, [Symbol("hidden")]: true };
    const hidden = { ...first }; Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
    const custom = Object.create({ inherited: true }); Object.assign(custom, first);

    // When / Then: no hostile descriptor can escape the exact parser error
    for (const malformed of [sparse, [accessor, ...traces.slice(1)], [symbol, ...traces.slice(1)],
      [hidden, ...traces.slice(1)], [custom, ...traces.slice(1)]]) invalid(source, malformed);
  });
});

describe("Task 19 exact safety and dependency reasons", () => {
  it("excludes safety and dependency observations from task quality and orders combined reasons once", () => {
    // Given: one otherwise perfect trace with all safety and dependency observations injected
    const source = corpus(); const traces = runPersonalOsCorpus(source); const first = traces[0];
    if (first === undefined) throw new TypeError("trace fixture missing");
    const safety = ["unauthorized", "approval_bypass", "duplicate", "stale_authoritative", "deletion_leak"] as const;
    const reasons = ["UNAUTHORIZED_EFFECTS_NONZERO", "APPROVAL_BYPASS_EFFECTS_NONZERO", "DUPLICATE_EFFECTS_NONZERO",
      "STALE_AUTHORITATIVE_EFFECTS_NONZERO", "DELETION_LEAK_EFFECTS_NONZERO"] as const;

    // When / Then: each independent event emits exactly one reason and combinations remain deterministic
    for (let index = 0; index < safety.length; index += 1) {
      const result = invoke(source, [{ ...first, effect_events: [safety[index]] }, ...traces.slice(1)]);
      expect(result).toMatchObject({ verdict: "fail", failed_reason_codes: [reasons[index]], task_quality: { rate: 1 } });
    }
    const dependencyCases = [["model_calls", "MODEL_DEPENDENCY_NONZERO"], ["network_calls", "NETWORK_DEPENDENCY_NONZERO"],
      ["mac_calls", "MAC_DEPENDENCY_NONZERO"]] as const;
    for (const [key, reason] of dependencyCases) {
      const result = invoke(source, [{ ...first, dependencies: { ...first.dependencies, [key]: 1 } }, ...traces.slice(1)]);
      expect(result).toMatchObject({ failed_reason_codes: [reason], task_quality: { rate: 1 } });
    }
    const combined = invoke(source, [{ ...first, effect_events: safety,
      dependencies: { model_calls: 1, network_calls: 2, mac_calls: 3 } }, ...traces.slice(1)]);
    expect(combined).toMatchObject({ failed_reason_codes: [...reasons, "MODEL_DEPENDENCY_NONZERO",
      "NETWORK_DEPENDENCY_NONZERO", "MAC_DEPENDENCY_NONZERO"], task_quality: { rate: 1 } });
  });
});
