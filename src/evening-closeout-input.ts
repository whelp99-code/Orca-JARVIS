import { types } from "node:util";
import type { CloseoutCitation, EveningCloseoutInput, EveningCloseoutLimits } from "./evening-closeout-types.js";
import { EveningCloseoutError } from "./evening-closeout-types.js";
import { containsPrivateMetadata } from "./private-text.js";

const DEFAULT_LIMITS: EveningCloseoutLimits = {
  max_items: 64, max_evidence_per_item: 16, max_candidates: 32,
  max_copy_bytes: 256, max_total_bytes: 65_536,
};
const fail = (): never => { throw new EveningCloseoutError("EVENING_CLOSEOUT_INPUT_INVALID"); };
type Input = Readonly<Record<string, unknown>>;
function object(value: unknown, keys: readonly string[]): Input {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return fail();
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined
        || descriptor.set !== undefined) return fail();
    }
    return Object.fromEntries(keys.map(key => [key, descriptors[key]?.value]));
  } catch (error) {
    if (error instanceof EveningCloseoutError) throw error;
    return fail();
  }
}
function array(value: unknown, maximum: number): readonly unknown[] {
  try {
    if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > maximum) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      return descriptor?.enumerable === true && descriptor.get === undefined && descriptor.set === undefined
        ? descriptor.value : fail();
    });
  } catch (error) {
    if (error instanceof EveningCloseoutError) throw error;
    return fail();
  }
}
function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || value !== value.normalize("NFC") || Buffer.byteLength(value) > maximum || containsPrivateMetadata(value)
    || [...value].some(character => {
      const code = character.charCodeAt(0); return code < 32 || code === 127;
    })) return fail();
  return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function instant(value: unknown): string {
  const parsed = text(value, 32); const time = Date.parse(parsed);
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed)
    && new Date(time).toISOString() === parsed ? parsed : fail();
}
function member<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  return typeof value === "string" ? values.find(candidate => candidate === value) ?? fail() : fail();
}
function integer(value: unknown, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value : fail();
}
function digest(value: unknown): string | null {
  if (value === null) return null;
  const parsed = text(value, 71); return /^sha256:[0-9a-f]{64}$/.test(parsed) ? parsed : fail();
}
function citation(value: unknown): CloseoutCitation {
  const input = object(value, ["source_id", "evidence_id"]);
  return { source_id: text(input["source_id"]), evidence_id: text(input["evidence_id"]) };
}
function citations(value: unknown, limit: number): readonly CloseoutCitation[] {
  const result = array(value, limit).map(citation);
  return result.length > 0 && new Set(result.map(item => `${item.source_id}\0${item.evidence_id}`)).size === result.length
    ? result : fail();
}
function limits(value: unknown): EveningCloseoutLimits {
  if (value === null) return DEFAULT_LIMITS;
  const input = object(value, [
    "max_items", "max_evidence_per_item", "max_candidates", "max_copy_bytes", "max_total_bytes",
  ]);
  return {
    max_items: integer(input["max_items"], 0, 64),
    max_evidence_per_item: integer(input["max_evidence_per_item"], 1, 16),
    max_candidates: integer(input["max_candidates"], 0, 32),
    max_copy_bytes: integer(input["max_copy_bytes"], 16, 256),
    max_total_bytes: integer(input["max_total_bytes"], 2048, 65_536),
  };
}
export function parseEveningCloseoutInput(value: unknown): EveningCloseoutInput {
  const input = object(value, [
    "schema_version", "run_id", "correlation_id", "local_date", "generated_at", "source_readiness",
    "source_omissions", "records", "decisions", "memory_candidates", "tomorrow_actions", "risks", "limits",
  ]);
  if (input["schema_version"] !== 1) return fail();
  const parsedLimits = limits(input["limits"]);
  const generatedAt = instant(input["generated_at"]);
  const records = array(input["records"], 256).map(value => {
    const item = object(value, [
      "item_id", "outcome", "reason", "copy", "citations", "observed_at", "fresh_until", "trust", "verification",
    ]);
    const verification = object(item["verification"], ["outcome", "evidence_id", "evidence_digest"]);
    const result = {
      item_id: text(item["item_id"]),
      outcome: member(item["outcome"], ["completed", "open", "failed", "worker_done"] as const),
      reason: nullableText(item["reason"]), copy: text(item["copy"], 4096),
      citations: citations(item["citations"], 128), observed_at: instant(item["observed_at"]),
      fresh_until: instant(item["fresh_until"]),
      trust: member(item["trust"], ["trusted", "untrusted", "conflicting"] as const),
      verification: {
        outcome: member(verification["outcome"], ["passed", "failed", "missing"] as const),
        evidence_id: nullableText(verification["evidence_id"]),
        evidence_digest: digest(verification["evidence_digest"]),
      },
    };
    if ((result.outcome !== "completed" && result.reason === null)
      || Date.parse(result.fresh_until) <= Date.parse(result.observed_at)) return fail();
    return result;
  });
  const decisions = array(input["decisions"], 128).map(value => {
    const item = object(value, ["decision_id", "state", "copy", "citations"]);
    return { decision_id: text(item["decision_id"]),
      state: member(item["state"], ["made", "owner_required"] as const), copy: text(item["copy"], 4096),
      citations: citations(item["citations"], 128) };
  });
  const memory = array(input["memory_candidates"], 128).map(value => {
    const item = object(value, ["candidate_id", "eligible", "citations"]);
    if (item["eligible"] !== true && item["eligible"] !== false) return fail();
    return { candidate_id: text(item["candidate_id"]), eligible: item["eligible"],
      citations: citations(item["citations"], 128) };
  });
  const actions = array(input["tomorrow_actions"], 128).map(value => {
    const item = object(value, ["action_id", "rank", "disposition", "citations"]);
    return { action_id: text(item["action_id"]), rank: integer(item["rank"], 1, 128),
      disposition: member(item["disposition"], ["executable", "delegated"] as const),
      citations: citations(item["citations"], 128) };
  });
  const risks = array(input["risks"], 128).map(value => {
    const item = object(value, ["risk_id", "copy", "citations"]);
    return { risk_id: text(item["risk_id"]), copy: text(item["copy"], 4096),
      citations: citations(item["citations"], 128) };
  });
  const readiness = member(input["source_readiness"], ["ready", "degraded", "no_data"] as const);
  const omissions = array(input["source_omissions"], 64).map(value => text(value));
  if ((readiness === "no_data" && records.length + decisions.length + memory.length + actions.length + risks.length > 0)
    || (readiness === "degraded" && omissions.length === 0)) return fail();
  const localDate = text(input["local_date"], 10);
  if (!/^\d{4}-\d\d-\d\d$/.test(localDate)) return fail();
  return {
    schema_version: 1, run_id: text(input["run_id"]), correlation_id: text(input["correlation_id"]), local_date: localDate,
    generated_at: generatedAt, source_readiness: readiness, source_omissions: omissions, records, decisions,
    memory_candidates: memory, tomorrow_actions: actions, risks, limits: parsedLimits,
  };
}
