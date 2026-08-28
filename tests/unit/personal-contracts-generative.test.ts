import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { canonicalPersonalContractHash, canonicalPersonalContractJson, PersonalContractError } from "../../src/personal-validation.js";
import {
  FAMILY_TAGS, GENERATIVE_RUNS_PER_SEED, GENERATIVE_SEEDS,
  generatedDiscriminantMutations, generatedMutations, validCorpusArbitrary,
  type GeneratedContract,
} from "../fixtures/personal-contract-generators.js";

const EXPECTED_TAGS = ["observation", "context", "recommendation", "daily", "notification", "memory_candidate", "memory_outbox", "remote_principal", "remote_challenge", "remote_approval"] as const;
const EXPECTED_DISCRIMINANTS = ["source_provider", "source_kind", "host", "authority", "freshness", "policy_decision", "policy_reason", "trust", "sensitivity", "observation_state", "context_state", "recommendation_state", "daily_phase", "daily_state", "notification_state", "notification_urgency", "notification_channel", "quiet_decision", "memory_kind", "memory_state", "memory_confidence", "confirmation_state", "memory_operation", "outbox_state", "client_kind", "principal_state", "challenge_state", "remote_decision", "approval_state"] as const;
const EXPECTED_HOSTILE = ["unknown_field", "missing_field", "symbol_field", "hidden_field", "accessor_field", "byte_overflow", "list_overflow", "duplicate_list", "depth_overflow", "key_overflow", "lifetime_overflow", "budget_overflow", "workflow_authority", "candidate_authority", "outbox_authority", "principal_authority", "remote_authority", "mixed_source", "invalid_id", "invalid_digest", "invalid_timestamp", "non_nfc"] as const;

function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)]));
}
function deeplyFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Reflect.ownKeys(value).every(key => deeplyFrozen(Reflect.get(value, key)));
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function object(value: unknown): Record<string, unknown> { if (!isObject(value)) throw new TypeError("generated object required"); return value; }
function tagged(corpus: readonly GeneratedContract[], tag: (typeof FAMILY_TAGS)[number]): GeneratedContract { const found = corpus.find(item => item.tag === tag); if (found === undefined) throw new RangeError(`missing ${tag}`); return found; }
function rejects(contract: GeneratedContract, input: unknown): void { expect(() => contract.parse(input)).toThrowError(PersonalContractError); }

function assertGeneratedBoundaries(corpus: readonly GeneratedContract[], wide: "é" | "界" | "😀"): void {
  const observation = tagged(corpus, "observation"); const context = tagged(corpus, "context"); const byteWidth = Buffer.byteLength(wide, "utf8"); const quotient = Math.floor(4_096 / byteWidth); const exactText = wide.repeat(quotient) + "a".repeat(4_096 - quotient * byteWidth);
  const textMax = object(structuredClone(observation.input)); object(textMax["payload"])["value"] = exactText; expect(observation.parse(textMax).payload).toBeDefined(); object(textMax["payload"])["value"] = `${exactText}a`; rejects(observation, textMax);
  const listMax = object(structuredClone(observation.input)); listMax["evidence"] = Array.from({ length: 32 }, (_, index) => ({ evidence_id: `evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f${index.toString(16).padStart(4, "0")}`, digest: `sha256:${index.toString(16).padStart(2, "0").repeat(32)}`, kind: "generated", source_id: "src:pos:v1:jarvis:primary", observed_at: "2026-08-28T09:58:00.000Z" })); expect(observation.parse(listMax).evidence).toHaveLength(32); const overflow = object(structuredClone(listMax)); const evidence = overflow["evidence"]; if (!Array.isArray(evidence)) throw new TypeError("evidence array required"); evidence.push({ evidence_id: "evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f0020" }); rejects(observation, overflow);
  let nested: unknown = wide; for (let depth = 0; depth < 6; depth++) nested = { next: nested }; const depthMax = object(structuredClone(observation.input)); object(depthMax["payload"])["value"] = nested; expect(observation.parse(depthMax).payload).toBeDefined(); object(depthMax["payload"])["value"] = { next: nested }; rejects(observation, depthMax);
  const keyMax = object(structuredClone(observation.input)); object(keyMax["payload"])["value"] = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`k${index}`, index])); expect(observation.parse(keyMax).payload).toBeDefined(); object(object(keyMax["payload"])["value"])["overflow"] = 65; rejects(observation, keyMax);
  const lifetime = object(structuredClone(observation.input)); lifetime["expires_at"] = "2026-09-28T10:00:00.000Z"; expect(observation.parse(lifetime).expires_at).toBe(lifetime["expires_at"]); lifetime["expires_at"] = "2026-09-28T10:00:00.001Z"; rejects(observation, lifetime);
  const total = object(structuredClone(observation.input)); const chunks = Array.from({ length: 15 }, () => "a".repeat(4_096)); object(total["payload"])["value"] = [...chunks, "a"]; const padding = 65_536 - Buffer.byteLength(canonicalize(total), "utf8"); if (padding < 0 || padding > 4_095) throw new RangeError("total padding"); object(total["payload"])["value"] = [...chunks, "a".repeat(padding + 1)]; expect(Buffer.byteLength(canonicalize(total), "utf8")).toBe(65_536); expect(observation.parse(total).payload).toBeDefined(); object(total["payload"])["value"] = [...chunks, "a".repeat(padding + 2)]; rejects(observation, total);
  const budget = object(structuredClone(context.input)); const payload = object(budget["payload"]); payload["query"] = "four"; payload["included_observation_refs"] = ["obs:1"]; payload["included_memory_refs"] = []; payload["omissions"] = []; const budgets = { max_items: 1, max_excerpt_bytes: 4, max_total_bytes: 1 }; payload["budgets"] = budgets; let prior = 0; for (let attempt = 0; attempt < 4; attempt++) { budgets.max_total_bytes = Buffer.byteLength(canonicalize(payload), "utf8"); if (budgets.max_total_bytes === prior) break; prior = budgets.max_total_bytes; } expect(context.parse(budget).payload).toBeDefined(); budgets.max_total_bytes--; rejects(context, budget);
}

describe("seeded personal contract generative corpus", () => {
  it("round-trips all ten families with varied canonical shapes and deep freeze", () => {
    const tags = new Set<string>(); const payloads = new Map<string, Set<string>>(); let samples = 0;
    for (const seed of GENERATIVE_SEEDS) fc.assert(fc.property(validCorpusArbitrary, corpus => {
      for (const contract of corpus) { const parsed = contract.parse(contract.input); const json = canonicalPersonalContractJson(parsed); const reparsed = contract.parse(JSON.parse(json)); const permuted = contract.parse(reordered(contract.input)); expect(canonicalPersonalContractHash(reparsed)).toBe(canonicalPersonalContractHash(parsed)); expect(canonicalPersonalContractHash(permuted)).toBe(canonicalPersonalContractHash(parsed)); expect(deeplyFrozen(parsed)).toBe(true); expect(json.normalize("NFC")).toBe(json); tags.add(contract.tag); const shapes = payloads.get(contract.tag) ?? new Set<string>(); shapes.add(canonicalize(parsed.payload)); payloads.set(contract.tag, shapes); samples++; }
    }), { seed, numRuns: GENERATIVE_RUNS_PER_SEED });
    expect([...tags].sort()).toEqual([...EXPECTED_TAGS].sort()); expect(samples).toBe(GENERATIVE_SEEDS.length * GENERATIVE_RUNS_PER_SEED * EXPECTED_TAGS.length); for (const tag of EXPECTED_TAGS) expect(payloads.get(tag)?.size).toBeGreaterThan(5);
  });

  it("rejects seeded hostile and exhaustive unknown-discriminant mutations", () => {
    const hostile = new Set<string>(); const discriminants = new Set<string>(); let failures = 0;
    for (const seed of GENERATIVE_SEEDS) fc.assert(fc.property(validCorpusArbitrary, fc.integer({ min: 1, max: 999_999 }), (corpus, n) => {
      const unknown = `unknown-${n}`; for (const mutation of generatedMutations(corpus, unknown)) { expect(() => mutation.parse(mutation.input)).toThrowError(PersonalContractError); expect(mutation.reads?.() ?? 0).toBe(0); hostile.add(mutation.kind); failures++; } for (const mutation of generatedDiscriminantMutations(corpus, unknown)) { expect(() => mutation.parse(mutation.input)).toThrowError(PersonalContractError); discriminants.add(mutation.kind); failures++; }
    }), { seed, numRuns: GENERATIVE_RUNS_PER_SEED });
    expect([...hostile].sort()).toEqual([...EXPECTED_HOSTILE].sort()); expect([...discriminants].sort()).toEqual([...EXPECTED_DISCRIMINANTS].sort()); expect(failures).toBe(GENERATIVE_SEEDS.length * GENERATIVE_RUNS_PER_SEED * (EXPECTED_HOSTILE.length + EXPECTED_DISCRIMINANTS.length));
  });

  it("generates exact max and max-plus-one boundaries from every recorded seed", () => {
    let runs = 0; for (const seed of GENERATIVE_SEEDS) fc.assert(fc.property(validCorpusArbitrary, fc.constantFrom("é", "界", "😀"), (corpus, wide) => { assertGeneratedBoundaries(corpus, wide); runs++; }), { seed, numRuns: GENERATIVE_RUNS_PER_SEED }); expect(runs).toBe(GENERATIVE_SEEDS.length * GENERATIVE_RUNS_PER_SEED);
  });
});
