import type { SecondBrainEvidence } from "../second-brain-adapter-types.js";
import type { MemoryPublicRecord } from "./memory-contracts.js";
import type { MemoryRecordLineage } from "./memory-record-history.js";
import { MemoryTokenCache } from "./memory-token-cache.js";

const REDACTED = "[REDACTED]";
const SUPERSEDED_TITLE = "Superseded record";
const SAFE_ORIGIN_LABEL = "Memory provider";
/** Human labels only: letters, digits, spaces, and light punctuation. Paths, schemes, and control characters fail. */
const ORIGIN_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .,'&()-]{0,63}$/u;
const NO_LINEAGE: MemoryRecordLineage = { forgotten: false, superseded_by: null, history: [] };

export function safeOriginLabel(label: string): string {
  return ORIGIN_LABEL.test(label) ? label : SAFE_ORIGIN_LABEL;
}

export function projectMemoryRecord(input: {
  readonly evidence: SecondBrainEvidence; readonly tokens: MemoryTokenCache;
  readonly sessionId: string; readonly sessionIncarnation?: string; readonly privacyEpoch: number;
  readonly policyDigest?: string; readonly now: Date; readonly lineage?: MemoryRecordLineage;
}): MemoryPublicRecord | undefined {
  const binding = input.evidence.record;
  const lineage = input.lineage ?? NO_LINEAGE;
  if (lineage.forgotten) return undefined;
  const issued = input.tokens.issue(input.evidence, input.sessionId, input.privacyEpoch,
    input.policyDigest, input.sessionIncarnation);
  if (binding === null || issued === undefined) return undefined;
  const privateTier = input.evidence.sensitivity === "sensitive"
    || input.evidence.sensitivity === "restricted";
  const superseded = lineage.superseded_by !== null;
  const excerpt = privateTier || superseded ? null : input.evidence.excerpt;
  const title = privateTier ? REDACTED : superseded ? SUPERSEDED_TITLE : titleFrom(excerpt);
  const originLabel = privateTier ? "Private source" : safeOriginLabel(binding.origin_label);
  const originRevision = privateTier ? null : input.tokens.revision("origin", input.sessionId,
    `${binding.origin_label}\0${binding.source_identity_full}`);
  const actions: MemoryPublicRecord["actions"] = superseded ? [] : privateTier ? ["forget", "export"]
    : ["inspect", "correct", "forget", "export"];
  return { record_token: issued.token, record_revision: issued.record_revision, title, excerpt,
    citation: privateTier ? "Private citation" : superseded ? "Superseded citation" : "Memory citation",
    sensitivity: input.evidence.sensitivity,
    retention: { source: "policy", days: 365, expires_at: input.evidence.expires_at },
    freshness: input.evidence.freshness.state,
    provenance: { source_class: "memory", owner_class: binding.source_owner_class,
      origin_label: originLabel, origin_revision: originRevision },
    conflict_state: "none", history_state: superseded ? "superseded" : "current",
    superseded_by: lineage.superseded_by, history: lineage.history, actions };
}
function titleFrom(excerpt: string | null): string {
  if (excerpt === null) return "Memory record";
  const line = excerpt.replace(/\[\^[0-9a-f]{8,64}\]/gu, "").trim();
  return line.length <= 96 ? line : `${line.slice(0, 93)}...`;
}
