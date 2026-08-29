import type { Sha256Digest } from "./personal-contracts.js";
import type { PriorityEngineResult } from "./priority-engine.js";
import { parsePriorityEngineResult } from "./priority-result-parser.js";

export const RECOMMENDATION_EVIDENCE_KINDS = [
  "principle", "policy", "owner", "current", "deadline", "dependency", "stable_identity",
] as const;
export type RecommendationEvidenceKind = (typeof RECOMMENDATION_EVIDENCE_KINDS)[number];
export type RecommendationActionMaterial = {
  readonly action_id: string;
  readonly title: string;
  readonly operation: string;
  readonly target_digest: Sha256Digest;
};
export type RecommendationEvidenceLink = {
  readonly ref: string;
  readonly kind: RecommendationEvidenceKind;
  readonly context_evidence_id: string | null;
  readonly digest: Sha256Digest;
};
export type RecommendationProvenance = {
  readonly ranking: PriorityEngineResult;
  readonly linux_evidence: readonly RecommendationEvidenceLink[];
  readonly actions: readonly RecommendationActionMaterial[];
  readonly approval_requirement: "none" | "owner";
  readonly confidence_class: "low" | "medium" | "high";
};

type Input = Readonly<Record<string, unknown>>;
const EFFECTS = new Set(["execute", "dispatch", "stage", "claim", "redeem", "settle"]);
const fail = (): never => { throw new RecommendationProvenanceContractError(); };
export class RecommendationProvenanceContractError extends Error {
  readonly name = "RecommendationProvenanceContractError";
  constructor() { super("RECOMMENDATION_PROVENANCE_INVALID"); }
}
function object(value: unknown, keys: readonly string[]): Input {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return fail();
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) fail();
  }
  return Object.fromEntries(keys.map(key => [key, descriptors[key]?.value]));
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) return fail();
    return descriptor.value;
  });
}
function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.normalize("NFC")
    || Buffer.byteLength(value, "utf8") > maximum) return fail();
  return value;
}
function digest(value: unknown): Sha256Digest {
  const parsed = text(value, 71);
  function valid(candidate: string): candidate is Sha256Digest { return /^sha256:[0-9a-f]{64}$/.test(candidate); }
  return valid(parsed) ? parsed : fail();
}
function operation(value: unknown): string {
  const parsed = text(value, 128);
  const segments = parsed.toLowerCase().split(/[\s.:/_-]+/u).filter(Boolean);
  return segments.some(segment => EFFECTS.has(segment)) ? fail() : parsed;
}
function member<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  return typeof value === "string" ? values.find(candidate => candidate === value) ?? fail() : fail();
}

export function parseRecommendationActionMaterials(value: unknown): readonly RecommendationActionMaterial[] {
  const values = array(value, 32);
  if (values.length === 0) return fail();
  return values.map(item => {
    const input = object(item, ["action_id", "title", "operation", "target_digest"]);
    return { action_id: text(input["action_id"]), title: text(input["title"]),
      operation: operation(input["operation"]), target_digest: digest(input["target_digest"]) };
  });
}
export function parseRecommendationEvidenceLinks(value: unknown): readonly RecommendationEvidenceLink[] {
  return array(value, 32).map(item => {
    const input = object(item, ["ref", "kind", "context_evidence_id", "digest"]);
    return { ref: text(input["ref"]), kind: member(input["kind"], RECOMMENDATION_EVIDENCE_KINDS),
      context_evidence_id: input["context_evidence_id"] === null ? null : text(input["context_evidence_id"]),
      digest: digest(input["digest"]) };
  });
}
export function parseRecommendationProvenance(value: unknown): RecommendationProvenance {
  try {
    const input = object(value, ["ranking", "linux_evidence", "actions", "approval_requirement", "confidence_class"]);
    return {
      ranking: parsePriorityEngineResult(input["ranking"]),
      linux_evidence: parseRecommendationEvidenceLinks(input["linux_evidence"]),
      actions: parseRecommendationActionMaterials(input["actions"]),
      approval_requirement: member(input["approval_requirement"], ["none", "owner"] as const),
      confidence_class: member(input["confidence_class"], ["low", "medium", "high"] as const),
    };
  } catch (error) {
    if (error instanceof RecommendationProvenanceContractError) throw error;
    if (error instanceof Error) throw new RecommendationProvenanceContractError();
    throw new RecommendationProvenanceContractError();
  }
}
