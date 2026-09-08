import { JarvisError, type AuthorityDb } from "./db.js";
import { readMemoryCandidate } from "./memory-candidate-reader.js";
import { memoryHash } from "./memory-candidate-values.js";

export const MEMORY_CANDIDATE_SCOPE_DOMAIN = "orca-jarvis/memory-candidate-scope-proposal/v1\0";
export type MemoryCandidateScopeInput = {
  readonly owner: "principal:owner";
  readonly projects: readonly string[];
  readonly policy_revision: string;
  readonly valid_until: string;
};
export type MemoryCandidateScopeProposal = {
  readonly schema_version: 1;
  readonly authorization: "not_granted";
  readonly candidate_id: string;
  readonly candidate_digest: string;
  readonly classification_digest: string;
  readonly source_digest: string;
  readonly scope: Readonly<{ owner: "principal:owner"; projects: readonly string[]; policy_revision: string }>;
  readonly proposed_at: string;
  readonly expires_at: string;
  readonly proposal_digest: string;
};
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const fail = (): never => { throw new JarvisError("MEMORY_CANDIDATE_SCOPE_INVALID"); };

/** Read-only proposal bound to a verified persisted candidate snapshot. The caller
 * proposes a scope; neither its existence nor the digest grants write authority. */
export function proposeMemoryCandidateScope(authority: AuthorityDb, candidateId: string,
  input: MemoryCandidateScopeInput, now: Date): MemoryCandidateScopeProposal {
  if (!/^memcand:pos:v1:[0-9a-f]{64}$/.test(candidateId) || !Number.isFinite(now.getTime())
    || input === null || typeof input !== "object" || Object.keys(input).sort().join(",") !== "owner,policy_revision,projects,valid_until"
    || input.owner !== "principal:owner" || typeof input.policy_revision !== "string" || !id.test(input.policy_revision)
    || !Array.isArray(input.projects) || input.projects.length > 64
    || !input.projects.every(value => typeof value === "string" && value.startsWith("project:") && id.test(value) && id.test(value.slice(8)))
    || new Set(input.projects).size !== input.projects.length || [...input.projects].sort().some((value, i) => value !== input.projects[i])
    || typeof input.valid_until !== "string") return fail();
  const expiry = Date.parse(input.valid_until);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== input.valid_until || expiry <= now.getTime()) return fail();
  const scope = Object.freeze({ owner: input.owner, projects: Object.freeze([...input.projects]), policy_revision: input.policy_revision });
  return authority.db.transaction(() => {
    const candidate = readMemoryCandidate(authority.db, candidateId);
    if (candidate === undefined || candidate.state === "rejected" || candidate.state === "expired"
      || candidate.source.principal_id !== scope.owner) return fail();
    const until = Math.min(expiry, Date.parse(candidate.candidate_expires_at));
    if (!Number.isFinite(until) || until <= now.getTime()) return fail();
    const core = { schema_version: 1 as const, authorization: "not_granted" as const,
      candidate_id: candidate.candidate_id, candidate_digest: candidate.candidate_digest,
      classification_digest: candidate.classification_digest, source_digest: candidate.source_digest,
      scope, proposed_at: now.toISOString(), expires_at: new Date(until).toISOString() };
    return Object.freeze({ ...core, proposal_digest: memoryHash(MEMORY_CANDIDATE_SCOPE_DOMAIN, core) });
  })();
}
