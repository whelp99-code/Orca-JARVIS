import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";

type Rule = { id: string; keywords: string[]; executor_ids: string[]; record_stores: string[] };
type Policy = { schema_version: 1; policy_id: string; revision: number; rules: Rule[] };
const foldAscii = (value: string): string => value.replace(/[A-Z]/g, char => char.toLowerCase());
const invalid = (): never => { throw new JarvisError("WORK_ROUTING_INPUT_INVALID"); };
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) invalid();
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0
    || value.normalize("NFC") !== value || Buffer.byteLength(value, "utf8") > max
    || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return invalid();
  return value;
}
function label(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-z][a-z0-9-]*$/.test(result)) invalid();
  return result;
}
function list<T>(value: unknown, max: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return invalid();
  const result = value.map(parse);
  if (new Set(result.map(item => foldAscii(String(item)))).size !== result.length) invalid();
  return result;
}
function parsePolicy(value: unknown): Policy {
  const row = object(value); keys(row, ["schema_version", "policy_id", "revision", "rules"]);
  if (row.schema_version !== 1 || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) invalid();
  if (!Array.isArray(row.rules) || row.rules.length === 0 || row.rules.length > 16) return invalid();
  const rules = row.rules.map(value => {
    const rule = object(value); keys(rule, ["id", "keywords", "executor_ids", "record_stores"]);
    return { id: label(rule.id), keywords: list(rule.keywords, 32, value => text(value, 128)),
      executor_ids: list(rule.executor_ids, 8, label), record_stores: list(rule.record_stores, 8, label) };
  });
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) invalid();
  return { schema_version: 1, policy_id: label(row.policy_id), revision: Number(row.revision), rules };
}
function matches(objective: string, keyword: string): boolean {
  const term = foldAscii(keyword);
  let offset = objective.indexOf(term);
  while (offset !== -1) {
    const before = offset === 0 ? "" : objective[offset - 1]!;
    const after = objective[offset + term.length] ?? "";
    if ((!/^[a-z0-9]/.test(term) || !/[a-z0-9_]/.test(before))
      && (!/[a-z0-9]$/.test(term) || !/[a-z0-9_]/.test(after))) return true;
    offset = objective.indexOf(term, offset + 1);
  }
  return false;
}
function digest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(`orca-jarvis/${domain}\0`).update(canonicalize(value)).digest("hex")}`;
}

/** Classification only. Executor labels carry no readiness, approval or dispatch authority. */
export function classifyWorkRouting(request: unknown, policyInput: unknown) {
  const row = object(request); keys(row, ["schema_version", "objective"]);
  if (row.schema_version !== 1) invalid();
  const objective = text(row.objective, 4096);
  const policy = parsePolicy(policyInput);
  const normalized = foldAscii(objective);
  const matched = policy.rules.flatMap(rule => {
    const matched_keywords = rule.keywords.filter(keyword => matches(normalized, keyword));
    return matched_keywords.length === 0 ? [] : [{ rule_id: rule.id, matched_keywords,
      proposed_executor_ids: rule.executor_ids, proposed_record_stores: rule.record_stores }];
  });
  const body = { schema_version: 1, policy_id: policy.policy_id, policy_revision: policy.revision,
    request_digest: digest("routing-request/v1", { schema_version: 1, objective }),
    policy_digest: digest("routing-policy/v1", policy),
    status: matched.length === 1 ? "classified" : "needs_review",
    reason: matched.length === 1 ? "single_rule_match" : matched.length === 0 ? "no_rule_match" : "multiple_rule_matches",
    executable: false, readiness: "not_probed", matches: matched };
  return { ...body, decision_digest: digest("routing-decision/v1", body) };
}
