import type { SecondBrainEvidence } from "../second-brain-adapter-types.js";
import type { MemoryPublicRecord } from "./memory-contracts.js";
import { MemoryTokenCache } from "./memory-token-cache.js";

const REDACTED = "[REDACTED]";
export function projectMemoryRecord(input: {
  readonly evidence: SecondBrainEvidence; readonly tokens: MemoryTokenCache;
  readonly sessionId: string; readonly privacyEpoch: number; readonly now: Date;
}): MemoryPublicRecord | undefined {
  const binding = input.evidence.record;
  const issued = input.tokens.issue(input.evidence, input.sessionId, input.privacyEpoch);
  if (binding === null || issued === undefined) return undefined;
  const privateTier = input.evidence.sensitivity === "sensitive"
    || input.evidence.sensitivity === "restricted";
  const excerpt = privateTier ? null : input.evidence.excerpt;
  const title = privateTier ? REDACTED : titleFrom(excerpt);
  const originRevision = privateTier ? null : input.tokens.revision("origin", input.sessionId,
    `${binding.origin_label}\0${binding.source_identity_full}`);
  const actions: MemoryPublicRecord["actions"] = privateTier ? ["forget", "export"]
    : ["inspect", "correct", "forget", "export"];
  return { record_token: issued.token, record_revision: issued.record_revision, title, excerpt,
    citation: privateTier ? "Private citation" : "Memory citation", sensitivity: input.evidence.sensitivity,
    retention: { source: "policy", days: 365, expires_at: input.evidence.expires_at },
    freshness: input.evidence.freshness.state,
    provenance: { source_class: "memory", owner_class: binding.source_owner_class,
      origin_label: privateTier ? "Private source" : binding.origin_label, origin_revision: originRevision },
    conflict_state: "none", history_state: "current", actions };
}
function titleFrom(excerpt: string | null): string {
  if (excerpt === null) return "Memory record";
  const line = excerpt.replace(/\[\^[0-9a-f]{8,64}\]/gu, "").trim();
  return line.length <= 96 ? line : `${line.slice(0, 93)}...`;
}
