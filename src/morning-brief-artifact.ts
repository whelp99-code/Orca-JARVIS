import { canonicalize } from "./canonical.js";
import { assertMorningItemIdentities, assertMorningItemSection, briefStrings, parseMorningBriefItem } from "./morning-brief-artifact-item.js";
import { parseMorningBriefLimits } from "./morning-brief-input.js";
import { array, digest, fail, hash, instant, integer, member, object, privateText } from "./morning-brief-parse-values.js";
import { MORNING_BRIEF_EXTERNAL_STATES, MORNING_BRIEF_OMISSION_REASONS, type MorningBriefResult } from "./morning-brief-types.js";

export class MorningBriefIntegrityError extends Error {
  readonly name = "MorningBriefIntegrityError";
  constructor() { super("MORNING_BRIEF_INTEGRITY_FAILURE"); }
}

function parseArtifact(value: unknown): MorningBriefResult {
  const input = object(value, ["schema_version", "brief_id", "generated_at", "context_readiness", "needs_you_first",
    "waiting", "fyi", "omissions", "omitted_count", "degradation_reasons", "abstention_reasons",
    "external_intelligence", "limits", "canonical_digest"]);
  if (input["schema_version"] !== 1 || input["limits"] === null) return fail();
  const limits = parseMorningBriefLimits(input["limits"]);
  const external = object(input["external_intelligence"], ["enabled", "skip_reason"]);
  const enabled = external["enabled"] === true ? true : external["enabled"] === false ? false : fail();
  const skip = external["skip_reason"] === null ? null : privateText(external["skip_reason"]);
  const allowed = MORNING_BRIEF_EXTERNAL_STATES.filter(state => !["off", "available"].includes(state))
    .map(state => `external_intelligence_${state}`);
  if (enabled ? skip !== null && !allowed.includes(skip) : skip !== "external_intelligence_disabled") return fail();
  const artifact: MorningBriefResult = {
    schema_version: 1, brief_id: privateText(input["brief_id"]), generated_at: instant(input["generated_at"]),
    context_readiness: member(input["context_readiness"], ["ready", "degraded", "no_data"] as const),
    needs_you_first: array(input["needs_you_first"], limits.max_needs_you_first).map(value => parseMorningBriefItem(value, limits)),
    waiting: array(input["waiting"], limits.max_waiting).map(value => parseMorningBriefItem(value, limits)),
    fyi: array(input["fyi"], limits.max_fyi).map(value => parseMorningBriefItem(value, limits)),
    omissions: array(input["omissions"], MORNING_BRIEF_OMISSION_REASONS.length).map(value => {
      const item = object(value, ["reason", "count"]);
      return { reason: member(item["reason"], MORNING_BRIEF_OMISSION_REASONS), count: integer(item["count"], 1, 65_536) };
    }),
    omitted_count: integer(input["omitted_count"], 0, 65_536),
    degradation_reasons: briefStrings(input["degradation_reasons"], 16),
    abstention_reasons: briefStrings(input["abstention_reasons"], 1),
    external_intelligence: { enabled, skip_reason: skip }, limits, canonical_digest: digest(input["canonical_digest"]),
  };
  const core = Object.fromEntries(Object.entries(artifact).filter(([key]) => !["brief_id", "canonical_digest"].includes(key)));
  const id = hash({ generated_at: artifact.generated_at, canonical_digest: artifact.canonical_digest });
  if (hash(core) !== artifact.canonical_digest || artifact.brief_id !== `morning-brief:v1:${id.slice(7)}`
    || Buffer.byteLength(canonicalize(artifact), "utf8") > limits.max_total_bytes) return fail();
  return artifact;
}

function assertSummary(artifact: MorningBriefResult): void {
  const items = [...artifact.needs_you_first, ...artifact.waiting, ...artifact.fyi];
  if (artifact.context_readiness === "no_data" && (items.length !== 0 || artifact.omitted_count !== 0
    || canonicalize(artifact.abstention_reasons) !== canonicalize(["no_data"]))) return fail();
  if (items.length > artifact.limits.max_total_items
    || artifact.omitted_count !== artifact.omissions.reduce((sum, item) => sum + item.count, 0)
    || new Set(artifact.omissions.map(item => item.reason)).size !== artifact.omissions.length) return fail();
  const expectedDegradation = [
    ...(artifact.context_readiness === "degraded" ? ["context_degraded"] : []),
    ...artifact.omissions.map(item => `omitted_${item.reason}`),
    ...(artifact.external_intelligence.skip_reason === null ? [] : [artifact.external_intelligence.skip_reason]),
  ].sort();
  if (canonicalize(expectedDegradation) !== canonicalize(artifact.degradation_reasons)) return fail();
  if (items.length > 0 ? artifact.abstention_reasons.length !== 0
    : artifact.abstention_reasons.length !== 1 || !["no_data", "no_authoritative_data"].includes(artifact.abstention_reasons[0] ?? "")) {
    return fail();
  }
  if (artifact.abstention_reasons.includes("no_data") && (artifact.context_readiness !== "no_data" || artifact.omitted_count !== 0)) return fail();
  for (const section of ["needs_you_first", "waiting", "fyi"] as const) {
    for (const item of artifact[section]) assertMorningItemSection(item, section, artifact.generated_at);
  }
  assertMorningItemIdentities(items);
}

/** Validates structure, integrity and generated-time invariants; does not certify source truth or execution authority. */
export function verifyMorningBriefResult(value: unknown): MorningBriefResult {
  try {
    const artifact = parseArtifact(value);
    assertSummary(artifact);
    return artifact;
  } catch {
    throw new MorningBriefIntegrityError();
  }
}
