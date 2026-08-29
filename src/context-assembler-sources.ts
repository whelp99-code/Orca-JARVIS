import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { MemoryEvidenceInput, MemoryInput } from "./context-assembler-input.js";
import type { ObservationEnvelopeV1 } from "./personal-contracts.js";

type ClassifiedSources = {
  readonly observations: readonly ObservationEnvelopeV1[]; readonly memories: readonly MemoryEvidenceInput[];
  readonly excluded: readonly string[]; readonly conflicts: readonly string[]; readonly omissions: readonly string[];
  readonly criticalGap: boolean;
};
type ClassificationState = {
  observations: ObservationEnvelopeV1[]; memories: MemoryEvidenceInput[]; excluded: string[]; conflicts: string[]; omissions: string[]; criticalGap: boolean;
};
type ClassificationLimits = { readonly clock: string; readonly maxExcerptBytes: number };

function token(code: string, reference: string): string {
  const digest = createHash("sha256").update(canonicalize(reference)).digest("hex").slice(0, 8);
  return `${code}:${digest}`;
}
function omit(state: ClassificationState, code: string, reference: string, critical = true): void {
  state.excluded.push(reference); state.omissions.push(token(code, reference)); state.criticalGap = state.criticalGap || critical;
}
function observation(state: ClassificationState, item: ObservationEnvelopeV1, clock: string): void {
  switch (item.payload.state) {
    case "fresh": {
      const linuxTask = item.source.host_id === "host:pos:linux-control-plane"
        && item.source.source_kind === "live_adapter" && item.payload.kind === "live_task";
      const current = item.freshness.state === "fresh"
        && Date.parse(item.freshness.fresh_until) > Date.parse(clock)
        && Date.parse(item.expires_at) > Date.parse(clock);
      if (linuxTask && current) state.observations.push(item);
      else omit(state, linuxTask ? "STALE_SOURCE" : "NON_LINUX_LIVE", item.id, linuxTask);
      return;
    }
    case "stale": omit(state, "STALE_SOURCE", item.id); return;
    case "no_data": omit(state, "NO_DATA", item.id); return;
    case "unavailable": case "offline": omit(state, "SOURCE_UNAVAILABLE", item.id); return;
    case "received": case "validated": omit(state, "SOURCE_NOT_FRESH", item.id); return;
    case "expired": case "rejected": omit(state, "SOURCE_REJECTED", item.id); return;
    default: { const exhaustive: never = item.payload.state; return exhaustive; }
  }
}
function memory(state: ClassificationState, item: MemoryInput, limits: ClassificationLimits): void {
  switch (item.kind) {
    case "gap":
      switch (item.state) {
        case "no_data": omit(state, "NO_DATA", item.memory_ref); return;
        case "unavailable": case "offline": omit(state, "SOURCE_UNAVAILABLE", item.memory_ref); return;
        default: { const exhaustive: never = item.state; return exhaustive; }
      }
    case "evidence":
      if (Buffer.byteLength(item.excerpt, "utf8") > limits.maxExcerptBytes) {
        omit(state, "EXCERPT_OVER_CAP", item.memory_ref); return;
      }
      if (item.relevance === "unrelated") {
        const code = item.sensitivity === "sensitive" || item.sensitivity === "restricted"
          ? "SENSITIVE_UNRELATED"
          : "UNRELATED_MEMORY";
        omit(state, code, item.memory_ref, false); return;
      }
      if (item.trust !== "user_confirmed") { omit(state, "UNCONFIRMED_MEMORY", item.memory_ref); return; }
      if (Date.parse(item.fresh_until) <= Date.parse(limits.clock)) { omit(state, "STALE_MEMORY", item.memory_ref); return; }
      switch (item.relation) {
        case "supports": state.memories.push(item); return;
        case "contradicts":
          state.excluded.push(item.memory_ref);
          state.conflicts.push(token("MEMORY_CONFLICT", item.memory_ref));
          state.criticalGap = true;
          return;
        default: { const exhaustive: never = item.relation; return exhaustive; }
      }
    default: { const exhaustive: never = item; return exhaustive; }
  }
}

export function classifyContextSources(
  observations: readonly ObservationEnvelopeV1[],
  memories: readonly MemoryInput[],
  limits: ClassificationLimits,
): ClassifiedSources {
  const state: ClassificationState = {
    observations: [], memories: [], excluded: [], conflicts: [], omissions: [], criticalGap: false,
  };
  for (const item of [...observations].sort((left, right) => left.id.localeCompare(right.id))) {
    observation(state, item, limits.clock);
  }
  for (const item of [...memories].sort((left, right) => left.memory_ref.localeCompare(right.memory_ref))) {
    memory(state, item, limits);
  }
  if (state.observations.length === 0) { state.omissions.push(token("LIVE_LINUX_REQUIRED", "live-linux")); state.criticalGap = true; }
  if (state.memories.length === 0) { state.omissions.push(token("MEMORY_REQUIRED", "confirmed-memory")); state.criticalGap = true; }
  return {
    observations: state.observations,
    memories: state.memories,
    excluded: [...new Set(state.excluded)].sort(),
    conflicts: [...new Set(state.conflicts)].sort(),
    omissions: [...new Set(state.omissions)].sort(),
    criticalGap: state.criticalGap,
  };
}
