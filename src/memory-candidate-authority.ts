import type Database from "better-sqlite3";
import { resolveControlMemoryAuthority } from "./memory-candidate-authority-control.js";
import type {
  MemoryAuthorityResolution,
  MemoryAuthorityResolverInput,
  ResolvedMemoryAuthority,
} from "./memory-candidate-authority-types.js";
import { resolveVerifiedMemoryAuthority } from "./memory-candidate-authority-verification.js";
import type { MemoryCandidateClassification } from "./memory-candidate-types.js";
import { memoryFail } from "./memory-candidate-values.js";

function existingClaimAllows(
  database: Database.Database,
  resolution: ResolvedMemoryAuthority,
  candidateId: string,
): boolean {
  const row = database.prepare(
    `SELECT c.candidate_id,m.classification_digest FROM memory_candidate_authority_claims c
     JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
     WHERE c.authority_kind=? AND c.authority_id=?`,
  ).get(resolution.claim.authority_kind, resolution.claim.authority_id) as Record<string, unknown> | undefined;
  return row === undefined || (row["candidate_id"] === candidateId && typeof row["classification_digest"] === "string");
}

function authorityRequired(inputClass: MemoryAuthorityResolverInput["input"]["source"]["input_class"]): boolean {
  return inputClass === "explicit_user_instruction" || inputClass === "verified_outcome"
    || inputClass === "approved_decision";
}

export function resolveMemoryCandidateAuthority(
  database: Database.Database,
  context: MemoryAuthorityResolverInput,
): MemoryAuthorityResolution {
  const inputClass = context.input.source.input_class;
  const resolution = inputClass === "verified_outcome"
    ? resolveVerifiedMemoryAuthority(database, context)
    : inputClass === "explicit_user_instruction" || inputClass === "approved_decision"
      ? resolveControlMemoryAuthority(database, context)
      : null;
  if (!resolution || !existingClaimAllows(database, resolution, context.identity.candidate_id)) return { valid: false };
  return resolution;
}

export function requireMemoryCandidateAuthority(
  database: Database.Database,
  context: MemoryAuthorityResolverInput,
): MemoryAuthorityResolution {
  const resolution = resolveMemoryCandidateAuthority(database, context);
  if (authorityRequired(context.input.source.input_class) && !resolution.valid) {
    return memoryFail("MEMORY_CANDIDATE_AUTHORITY_INVALID");
  }
  return resolution;
}

export function claimMemoryCandidateAuthority(
  database: Database.Database,
  resolution: MemoryAuthorityResolution,
  classification: MemoryCandidateClassification,
): void {
  if (!resolution.valid || classification.state === "rejected" || classification.state === "expired") return;
  database.prepare(
    `INSERT INTO memory_candidate_authority_claims(
      authority_kind,authority_id,candidate_id,classification_digest,claimed_at
     ) VALUES(?,?,?,?,?) ON CONFLICT(authority_kind,authority_id) DO NOTHING`,
  ).run(
    resolution.claim.authority_kind,
    resolution.claim.authority_id,
    classification.candidate_id,
    classification.classification_digest,
    classification.created_at,
  );
  const row = database.prepare(
    "SELECT candidate_id,classification_digest FROM memory_candidate_authority_claims WHERE authority_kind=? AND authority_id=?",
  ).get(resolution.claim.authority_kind, resolution.claim.authority_id) as Record<string, unknown> | undefined;
  if (!row || row["candidate_id"] !== classification.candidate_id
    || row["classification_digest"] !== classification.classification_digest) {
    return memoryFail("MEMORY_CANDIDATE_AUTHORITY_INVALID");
  }
}
