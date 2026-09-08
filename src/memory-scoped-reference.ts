import { JarvisError, type AuthorityDb } from "./db.js";
import type { createMemoryScopedClient } from "./memory-scoped-client.js";
import { MemoryReferenceReader } from "./memory-reference-reader.js";
import type { MemoryMembership } from "./memory-read-privacy.js";
import type { SecondBrainReadOutcome, SecondBrainEvidence } from "./second-brain-adapter-types.js";

/** One authenticated scope lifetime. Recreate after a session/policy/high-water
 * change; old prepared references must not move to the new scope. */
export function createScopedMemoryReference(authority: AuthorityDb, options: {
  readonly client: ReturnType<typeof createMemoryScopedClient>;
  readonly membership: MemoryMembership;
  readonly clock: () => Date;
  readonly search_limit: number;
}) {
  if (!Number.isSafeInteger(options.search_limit) || options.search_limit < 1 || options.search_limit > 50) {
    throw new JarvisError("MEMORY_SCOPED_REFERENCE_INVALID");
  }
  const initial = options.client.authorizationIdentity();
  const assertAuthorized = () => {
    if (options.client.authorizationIdentity() !== initial) throw new JarvisError("MEMORY_REFERENCE_SCOPE_CHANGED");
  };
  const search = async (query: string): Promise<SecondBrainReadOutcome> => {
    assertAuthorized();
    const response = await options.client.search(query, options.search_limit);
    assertAuthorized();
    const checked_at = options.clock().toISOString();
    const evidence: SecondBrainEvidence[] = [];
    let stale = false;
    for (const page of response.pages) {
      if (page.parsed.kind === "conflicts") return { kind: "conflicts", checked_at, conflicts: page.parsed.conflicts };
      stale ||= page.parsed.kind === "stale";
      evidence.push(...page.parsed.evidence);
    }
    if (stale) return { kind: "stale", code: "SECOND_BRAIN_EVIDENCE_STALE", checked_at, evidence };
    return evidence.length === 0 ? { kind: "no_data", checked_at, generation: response.generation,
      fresh_until: new Date(Date.parse(checked_at) + 60000).toISOString() } : { kind: "current", checked_at, evidence };
  };
  return new MemoryReferenceReader({ authority, membership: options.membership, clock: options.clock,
    adapter: { search }, assert_authorized: assertAuthorized,
    generation_status: async () => {
      assertAuthorized();
      const status = await options.client.status();
      assertAuthorized();
      return { kind: "data", value: { schema_version: 1, ...status.generation,
        pointer_health: "healthy", journal_health: "healthy" } };
    } });
}
