import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";

const PRIVATE_KEY = /(?:password|passwd|token|secret|credential|cookie|authorization|private[_-]?key)/iu;
const SURROGATE = /[\uD800-\uDFFF]/u;
type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type ParsedRecommendationWorkflowRequest = {
  readonly recommendationId: string;
  readonly actionRank: number;
  readonly principalId: string;
  readonly sessionId: string;
  readonly repository: string;
  readonly environment: "local";
  readonly goal: string;
  readonly workflowArgs: { readonly [key: string]: Json };
  readonly budget: {
    readonly max_steps: number;
    readonly max_attempts_per_node: number;
    readonly deadline: string;
  };
};
function fail(code = "RECOMMENDATION_WORKFLOW_INVALID"): never { throw new JarvisError(code); }
function plain(value: unknown, keys?: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value); const own = Reflect.ownKeys(value);
    if (own.some(key => typeof key !== "string")
      || (keys !== undefined && (own.length !== keys.length
        || own.some(key => !keys.includes(String(key)))))) return fail();
    for (const key of own) {
      const descriptor = descriptors[String(key)];
      if (descriptor === undefined || !descriptor.enumerable
        || descriptor.get !== undefined || descriptor.set !== undefined) return fail();
    }
    return Object.fromEntries(own.map(key => [String(key), descriptors[String(key)]?.value]));
  } catch (error) { if (error instanceof JarvisError) throw error; return fail(); }
}
function text(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.normalize("NFC")
    || SURROGATE.test(value) || Buffer.byteLength(value, "utf8") > maximum) return fail();
  return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value) : fail();
}
function json(value: unknown, depth = 0): Json {
  if (depth > 4) return fail();
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" ? text(value, 1024) : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : fail();
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 16) return fail();
    return value.map(item => json(item, depth + 1));
  }
  const input = plain(value);
  if (Object.keys(input).length > 16) return fail();
  return Object.fromEntries(Object.entries(input).map(([key, item]) => {
    if (PRIVATE_KEY.test(key)) return fail("RECOMMENDATION_WORKFLOW_PRIVATE_INPUT");
    return [text(key, 64), json(item, depth + 1)];
  }));
}
function workflowArgs(value: unknown): { readonly [key: string]: Json } {
  const input = plain(value);
  const parsed = Object.fromEntries(Object.entries(input).map(([key, item]) => {
    if (PRIVATE_KEY.test(key)) return fail("RECOMMENDATION_WORKFLOW_PRIVATE_INPUT");
    return [text(key, 64), json(item, 1)];
  }));
  if (Buffer.byteLength(canonicalize(parsed), "utf8") > 4096) return fail();
  return parsed;
}
export function parseRecommendationWorkflowRequest(value: unknown): ParsedRecommendationWorkflowRequest {
  const input = plain(value, [
    "schema_version", "recommendation_id", "action_rank", "requested_by",
    "target", "workflow", "budget", "deadline",
  ]);
  if (input["schema_version"] !== 1) return fail();
  const requested = plain(input["requested_by"], ["principal_id", "authenticated_session_id"]);
  const target = plain(input["target"], ["repository", "environment"]);
  const workflow = plain(input["workflow"], ["goal", "args"]);
  const budget = plain(input["budget"], ["max_steps", "max_attempts_per_node"]);
  const deadline = text(input["deadline"], 32);
  if (target["environment"] !== "local" || new Date(Date.parse(deadline)).toISOString() !== deadline) return fail();
  return {
    recommendationId: text(input["recommendation_id"], 80),
    actionRank: integer(input["action_rank"], 1, 32),
    principalId: text(requested["principal_id"], 128),
    sessionId: text(requested["authenticated_session_id"], 128),
    repository: text(target["repository"], 256), environment: "local",
    goal: text(workflow["goal"], 4096), workflowArgs: workflowArgs(workflow["args"]),
    budget: {
      max_steps: integer(budget["max_steps"], 1, 100),
      max_attempts_per_node: integer(budget["max_attempts_per_node"], 1, 10), deadline,
    },
  };
}
export function parseStagedRecommendationWorkflow(args: Readonly<Record<string, unknown>>): ParsedRecommendationWorkflowRequest {
  const input = plain(args["input"]); const budget = plain(args["budget"]);
  return {
    recommendationId: text(input["recommendation_id"]),
    actionRank: integer(input["action_rank"], 1, 32),
    principalId: text(input["requested_by_principal_id"]),
    sessionId: text(input["authenticated_session_id"]),
    repository: text(input["target_repository"]), environment: "local",
    goal: text(input["goal"], 4096), workflowArgs: workflowArgs(input["workflow_args"]),
    budget: {
      max_steps: integer(budget["max_steps"], 1, 100),
      max_attempts_per_node: integer(budget["max_attempts_per_node"], 1, 10),
      deadline: text(budget["deadline"], 32),
    },
  };
}
export function stagedRecommendationWorkflowInput(args: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return plain(args["input"]);
}
