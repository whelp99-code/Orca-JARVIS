import { normalizePersonalObservations } from "../../src/index.js";
import { observationTask } from "./personal-observation-input.js";

export const CONTEXT_NOW = "2026-08-28T12:00:00.000Z";
const DIGEST_A = `sha256:${"a".repeat(64)}`;

export function contextAssemblerInput(): Readonly<Record<string, unknown>> {
  const live = normalizePersonalObservations({
    checked_at: CONTEXT_NOW,
    orca_tasks: [observationTask("local")],
    portfolios: [],
  });
  return {
    purpose: "daily_prioritization",
    query: "what now?",
    clock: CONTEXT_NOW,
    expires_in_ms: 240_000,
    budgets: { max_items: 16, max_excerpt_bytes: 128, max_total_bytes: 4096 },
    observations: live,
    pending_authority_refs: ["request:owner:deploy"],
    memories: [{
      kind: "evidence",
      memory_ref: "sid:principle:customer-first",
      source_id: "src:pos:v1:second-brain:primary",
      digest: DIGEST_A,
      observed_at: "2026-08-28T11:30:00.000Z",
      fresh_until: "2026-08-28T13:00:00.000Z",
      excerpt: "Prioritize confirmed customer obligations before internal improvements.",
      trust: "user_confirmed",
      sensitivity: "personal",
      relevance: "related",
      relation: "supports",
    }],
  };
}
