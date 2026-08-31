import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SENTINEL = "SECOND_BRAIN_CONTRACT_MISMATCH";
const IMPLEMENTATION_COMMIT = "30cebe1670c0b65dc9832066a09c2c64f8371b20";
const EXPECTED_DIGEST = "1406f97695970a099af2569ab93777b67603a2a2261b9f6d03646e430d6098fe";
const TOOLS = [
  "sb_generation_status", "sb_open_conflicts", "sb_read_page", "sb_recent_changes", "sb_remember",
  "sb_request_status", "sb_resolve_memory_target", "sb_search", "sb_write_request",
] as const;

export class SecondBrainContractError extends Error {
  readonly code = SENTINEL;
  constructor() { super(SENTINEL); this.name = "SecondBrainContractError"; }
}
export type SecondBrainContractSummary = {
  readonly schemaVersion: 3; readonly implementationCommit: string; readonly tools: readonly string[];
  readonly digest: string; readonly rememberBehavior: "non_idempotent_collision_safe_no_overwrite";
  readonly features: readonly string[]; readonly toolCount: 9;
};
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SecondBrainContractError();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new SecondBrainContractError();
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new SecondBrainContractError(); return value;
}
export function consumeSecondBrainContract(fixturePath: string, sourcePath?: string): SecondBrainContractSummary {
  const payload = readFileSync(fixturePath); const digest = createHash("sha256").update(payload).digest("hex");
  if (digest !== EXPECTED_DIGEST || readFileSync(`${fixturePath}.sha256`, "ascii") !== `${digest}\n`
    || (sourcePath !== undefined && (!payload.equals(readFileSync(sourcePath))
      || readFileSync(`${sourcePath}.sha256`, "ascii") !== `${digest}\n`))) throw new SecondBrainContractError();
  const root = record(JSON.parse(payload.toString("utf8")) as unknown);
  exact(root, ["application", "canonicalization", "errors", "normalization", "schema_version", "tools", "vectors"]);
  if (root.schema_version !== 3) throw new SecondBrainContractError();
  const application = record(root.application); exact(application, ["implementation_commit", "implementation_commit_role"]);
  if (application.implementation_commit !== IMPLEMENTATION_COMMIT
    || application.implementation_commit_role !== "task28_entry_baseline") throw new SecondBrainContractError();
  const tools = record(root.tools); exact(tools, TOOLS);
  for (const name of TOOLS) {
    const tool = record(tools[name]);
    if (!("arguments" in tool) || !("happy" in tool) || !("no_data" in tool)) throw new SecondBrainContractError();
  }
  const remember = record(tools.sb_remember); const repeated = record(remember.repeated_call);
  if (repeated.behavior !== "non_idempotent_collision_safe_no_overwrite"
    || repeated.paths_are_distinct !== true || repeated.same_input_creates_distinct_files !== true) throw new SecondBrainContractError();
  const vectors = record(root.vectors);
  exact(vectors, ["correction", "delegation_revocation", "export", "features", "forget", "tool_count"]);
  const correction = record(vectors.correction);
  if (vectors.tool_count !== 9 || correction.envelope_bytes !== 6426
    || correction.request_digest !== "sha256:3b785d65b826d91040d99a1f1a99f4981547bc2909c20ddda39295e4a1c10ffa"
    || correction.envelope_digest !== "sha256:3f324697dd8c0e69c3ea29f76b945282be3f16ff5935ed49c997597fa33c807e"
    || array(root.errors).length < 35) throw new SecondBrainContractError();
  const features = array(vectors.features);
  if (!features.every(feature => typeof feature === "string")) throw new SecondBrainContractError();
  return { schemaVersion: 3, implementationCommit: IMPLEMENTATION_COMMIT, tools: TOOLS, digest,
    rememberBehavior: "non_idempotent_collision_safe_no_overwrite", features: features as string[], toolCount: 9 };
}
function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write("usage: node src/second-brain-contract.ts --fixture PATH [--source PATH]\n"); return;
  }
  if ((args.length !== 2 && args.length !== 4) || args[0] !== "--fixture" || args[1] === undefined
    || (args.length === 4 && (args[2] !== "--source" || args[3] === undefined))) throw new SecondBrainContractError();
  process.stdout.write(`${consumeSecondBrainContract(args[1], args[3]).digest}\n`);
}
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try { main(); } catch { process.stderr.write(`${SENTINEL}\n`); process.exitCode = 1; }
}
