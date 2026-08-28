import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SENTINEL = "SECOND_BRAIN_CONTRACT_MISMATCH";
const IMPLEMENTATION_COMMIT = "011abade5b29de66af4722dfd9c21398064eeb1e";
const EXPECTED_DIGEST = "2749af8b2a87b34e8a46191051d03126ff5bceebfb38c3f7a0b1acb0239acbaa";
const TOOLS = ["sb_open_conflicts", "sb_read_page", "sb_recent_changes", "sb_remember", "sb_search"] as const;
const ERROR_CODES = ["INVALID_ARGUMENTS", "PAGE_NOT_FOUND", "PATH_ESCAPE", "REMEMBER_REJECTED"] as const;

export class SecondBrainContractError extends Error {
  readonly code = SENTINEL;

  constructor() {
    super(SENTINEL);
    this.name = "SecondBrainContractError";
  }
}

export type SecondBrainContractSummary = {
  readonly schemaVersion: 1;
  readonly implementationCommit: string;
  readonly tools: readonly string[];
  readonly digest: string;
  readonly rememberBehavior: "non_idempotent_collision_safe_no_overwrite";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new SecondBrainContractError();
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = record(value);
  return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(",")}}`;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new SecondBrainContractError();
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new SecondBrainContractError();
  return value;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new SecondBrainContractError();
  return value;
}

function expectedArguments(tool: string): unknown {
  switch (tool) {
    case "sb_open_conflicts": return { additionalProperties: false, properties: {}, required: [], type: "object" };
    case "sb_read_page": return { additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"], type: "object" };
    case "sb_recent_changes": return { additionalProperties: false, properties: { days: { default: 7, type: "integer" } }, required: [], type: "object" };
    case "sb_remember": return { additionalProperties: false, properties: { content: { type: "string" }, title: { default: null, type: ["string", "null"] } }, required: ["content"], type: "object" };
    case "sb_search": return { additionalProperties: false, properties: { limit: { default: 10, type: "integer" }, query: { type: "string" } }, required: ["query"], type: "object" };
    default: throw new SecondBrainContractError();
  }
}

function validateTool(name: string, value: unknown): void {
  const tool = record(value);
  const keys = name === "sb_remember"
    ? ["arguments", "dynamic_fields", "happy", "no_data", "repeated_call"]
    : name === "sb_search" || name === "sb_read_page" || name === "sb_recent_changes"
      ? ["arguments", "dynamic_fields", "happy", "no_data"]
      : ["arguments", "happy", "no_data"];
  exactKeys(tool, keys);
  if (canonicalJson(tool["arguments"]) !== canonicalJson(expectedArguments(name))) throw new SecondBrainContractError();
  const happy = record(tool["happy"]);
  exactKeys(happy, ["arguments", "normalized", "raw_response"]);
  const normalized = record(happy["normalized"]);
  exactKeys(normalized, ["kind", "value"]);
  if (normalized["kind"] !== "data") throw new SecondBrainContractError();
  if (name === "sb_read_page" || name === "sb_remember") {
    if (tool["no_data"] !== null) throw new SecondBrainContractError();
  } else {
    const noData = record(tool["no_data"]);
    exactKeys(noData, ["normalized", "raw_response"]);
    const outcome = record(noData["normalized"]);
    exactKeys(outcome, ["kind", "reason"]);
    if (outcome["kind"] !== "no_data" || outcome["reason"] !== "empty_result") throw new SecondBrainContractError();
  }
  if (name === "sb_remember") {
    const repeated = record(tool["repeated_call"]);
    exactKeys(repeated, ["behavior", "paths_are_distinct", "same_input_creates_distinct_files"]);
    if (repeated["behavior"] !== "non_idempotent_collision_safe_no_overwrite"
      || repeated["paths_are_distinct"] !== true || repeated["same_input_creates_distinct_files"] !== true) throw new SecondBrainContractError();
  }
}

export function consumeSecondBrainContract(fixturePath: string, sourcePath?: string): SecondBrainContractSummary {
  const payload = readFileSync(fixturePath);
  const text = payload.toString("utf8");
  const digest = createHash("sha256").update(payload).digest("hex");
  if (digest !== EXPECTED_DIGEST) throw new SecondBrainContractError();
  if (!/^[0-9a-f]{64}\n$/.test(readFileSync(`${fixturePath}.sha256`, "ascii"))
    || readFileSync(`${fixturePath}.sha256`, "ascii") !== `${digest}\n`) throw new SecondBrainContractError();
  if (sourcePath !== undefined && (!payload.equals(readFileSync(sourcePath))
    || readFileSync(`${sourcePath}.sha256`, "ascii") !== `${digest}\n`)) throw new SecondBrainContractError();
  const parsed: unknown = JSON.parse(text);
  const root = record(parsed);
  exactKeys(root, ["application", "canonicalization", "errors", "normalization", "schema_version", "tools"]);
  if (root["schema_version"] !== 1) throw new SecondBrainContractError();
  if (canonicalJson(root["canonicalization"]) !== canonicalJson({ encoding: "utf-8", json: "sorted_keys_compact_separators_trailing_newline", sha256_sidecar: "64_lowercase_hex_newline" })
    || canonicalJson(root["normalization"]) !== canonicalJson({ boundary: "fixture_export_only", raw_response_and_error_preserved: true, typed_outcomes: ["data", "no_data", "error"] })) throw new SecondBrainContractError();
  const application = record(root["application"]);
  exactKeys(application, ["implementation_commit", "implementation_commit_role"]);
  if (application["implementation_commit"] !== IMPLEMENTATION_COMMIT
    || application["implementation_commit_role"] !== "reviewed_pre_fixture_runtime") throw new SecondBrainContractError();
  const tools = record(root["tools"]);
  exactKeys(tools, TOOLS);
  for (const tool of TOOLS) validateTool(tool, tools[tool]);
  const errors = array(root["errors"]);
  if (errors.length !== ERROR_CODES.length) throw new SecondBrainContractError();
  const observedCodes = errors.map(error => {
    const entry = record(error);
    const code = string(entry["code"]);
    const errorClass = string(entry["class"]);
    if (code === "INVALID_ARGUMENTS") {
      exactKeys(entry, ["class", "code", "raw_error_pattern"]);
      string(entry["raw_error_pattern"]);
      if (errorClass !== "pydantic.ValidationError") throw new SecondBrainContractError();
    } else {
      exactKeys(entry, ["class", "code", "raw_error"]);
      string(entry["raw_error"]);
      if (errorClass !== "ToolError") throw new SecondBrainContractError();
    }
    return code;
  }).sort();
  if (observedCodes.join("\0") !== [...ERROR_CODES].sort().join("\0")) throw new SecondBrainContractError();
  return { schemaVersion: 1, implementationCommit: IMPLEMENTATION_COMMIT, tools: TOOLS, digest, rememberBehavior: "non_idempotent_collision_safe_no_overwrite" };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write("usage: node src/second-brain-contract.ts --fixture PATH [--source PATH]\n");
    return;
  }
  if ((args.length !== 2 && args.length !== 4) || args[0] !== "--fixture" || args[1] === undefined
    || (args.length === 4 && (args[2] !== "--source" || args[3] === undefined))) throw new SecondBrainContractError();
  process.stdout.write(`${consumeSecondBrainContract(args[1], args[3]).digest}\n`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    main();
  } catch (error) {
    if (!(error instanceof Error)) process.exitCode = 1;
    process.stderr.write(`${SENTINEL}\n`);
    process.exitCode = 1;
  }
}
