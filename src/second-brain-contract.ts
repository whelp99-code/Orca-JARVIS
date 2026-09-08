import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SENTINEL = "SECOND_BRAIN_CONTRACT_MISMATCH";
const PROFILES = {
  schema7: { schemaVersion: 7, implementationCommit: "df9412c2016bbf0e71e747f9c4da8ef88b3eb654",
    implementationRole: "cancellation_submission_entry_baseline", digest: "d137a7a7b0e4a577abef04d6ecb2768630e9912cd24b8f270c320cb45d60165d" },
  schema6: {
    schemaVersion: 6,
    implementationCommit: "6da593e8306fc3de23a3342fe6d1480753d2ed4d",
    implementationRole: "cancellation_status_entry_baseline",
    digest: "8be1ca195f60cb73f05c989d3d5f3e62053020988ccd8bb028cd4d8b442063b4",
  },
  schema3: {
    schemaVersion: 3,
    implementationCommit: "30cebe1670c0b65dc9832066a09c2c64f8371b20",
    implementationRole: "task28_entry_baseline",
    digest: "1406f97695970a099af2569ab93777b67603a2a2261b9f6d03646e430d6098fe",
  },
  schema5: {
    schemaVersion: 5,
    implementationCommit: "0b5a881acd782abc031a57929af7f95941719bf0",
    implementationRole: "remember_v3_entry_baseline",
    digest: "78def950055c108a11790ea9d2f6f7729d1084114b09e89fef6a735e04e65d5e",
  },
  schema4: {
    schemaVersion: 4,
    implementationCommit: "313adfb90accb6b9687d4826c305887066166170",
    implementationRole: "task32_entry_baseline",
    digest: "ae2e4b4f41ade29e8781e47e60dad6ddb17ed8cea516b82ccd16454acd5dc3e0",
  },
} as const;
const TOOLS = [
  "sb_generation_status", "sb_open_conflicts", "sb_read_page", "sb_recent_changes", "sb_remember",
  "sb_request_status", "sb_resolve_memory_target", "sb_search", "sb_write_request",
] as const;

export class SecondBrainContractError extends Error {
  readonly code = SENTINEL;
  constructor() { super(SENTINEL); this.name = "SecondBrainContractError"; }
}
export type SecondBrainContractSummary = {
  readonly schemaVersion: 3 | 4 | 5 | 6 | 7; readonly implementationCommit: string; readonly tools: readonly string[];
  readonly digest: string; readonly rememberBehavior: "non_idempotent_collision_safe_no_overwrite";
  readonly features: readonly string[]; readonly toolCount: 9 | 10 | 11;
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
  const profile = digest === PROFILES.schema3.digest ? PROFILES.schema3
    : digest === PROFILES.schema4.digest ? PROFILES.schema4
    : digest === PROFILES.schema5.digest ? PROFILES.schema5
    : digest === PROFILES.schema7.digest ? PROFILES.schema7
    : digest === PROFILES.schema6.digest ? PROFILES.schema6 : undefined;
  if (profile === undefined || readFileSync(`${fixturePath}.sha256`, "ascii") !== `${digest}\n`
    || (sourcePath !== undefined && (!payload.equals(readFileSync(sourcePath))
      || readFileSync(`${sourcePath}.sha256`, "ascii") !== `${digest}\n`))) throw new SecondBrainContractError();
  const parsed: unknown = JSON.parse(payload.toString("utf8"));
  const root = record(parsed);
  exact(root, ["application", "canonicalization", "errors", "normalization", "schema_version", "tools", "vectors"]);
  if (root.schema_version !== profile.schemaVersion) throw new SecondBrainContractError();
  const application = record(root.application); exact(application, ["implementation_commit", "implementation_commit_role"]);
  if (application.implementation_commit !== profile.implementationCommit
    || application.implementation_commit_role !== profile.implementationRole) throw new SecondBrainContractError();
  const expectedTools = [...TOOLS, ...(profile.schemaVersion >= 6 ? ["sb_cancellation_status"] : []), ...(profile.schemaVersion === 7 ? ["sb_submit_cancellation"] : [])];
  const toolCount = profile.schemaVersion === 7 ? 11 : profile.schemaVersion === 6 ? 10 : 9;
  const tools = record(root.tools); exact(tools, expectedTools);
  for (const name of expectedTools) {
    const tool = record(tools[name]);
    if (!("arguments" in tool) || !("happy" in tool) || !("no_data" in tool)) throw new SecondBrainContractError();
  }
  const remember = record(tools.sb_remember); const repeated = record(remember.repeated_call);
  if (repeated.behavior !== "non_idempotent_collision_safe_no_overwrite"
    || repeated.paths_are_distinct !== true || repeated.same_input_creates_distinct_files !== true) throw new SecondBrainContractError();
  const vectors = record(root.vectors);
  exact(vectors, ["correction", "delegation_revocation", "export", "features", "forget", "tool_count",
    ...(profile.schemaVersion >= 5 ? ["remember_v3"] : [])]);
  const correction = record(vectors.correction);
  if (vectors.tool_count !== toolCount || correction.envelope_bytes !== 6426
    || correction.request_digest !== "sha256:3b785d65b826d91040d99a1f1a99f4981547bc2909c20ddda39295e4a1c10ffa"
    || correction.envelope_digest !== "sha256:3f324697dd8c0e69c3ea29f76b945282be3f16ff5935ed49c997597fa33c807e"
    || array(root.errors).length < 35) throw new SecondBrainContractError();
  if (profile.schemaVersion >= 5) {
    const rememberV3 = record(vectors.remember_v3); const request = record(rememberV3.request);
    if (request.schema_version !== 3 || request.body_profile !== "plain-text-v1" || request.operation !== "remember"
      || rememberV3.request_digest !== "sha256:516cb892108e4758f5c13312eda92b6c2c720d9fc9aefebd9f973b2fe5d7320b") {
      throw new SecondBrainContractError();
    }
  }
  const features = array(vectors.features);
  if (!features.every(feature => typeof feature === "string")) throw new SecondBrainContractError();
  return { schemaVersion: profile.schemaVersion, implementationCommit: profile.implementationCommit, tools: expectedTools, digest,
    rememberBehavior: "non_idempotent_collision_safe_no_overwrite", features: features as string[], toolCount };
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
