import type {
  MemoryCandidateIdentity,
  MemoryCandidateSourceMetadata,
  ParsedMemoryCandidateInput,
  ParsedMemoryReference,
} from "./memory-candidate-types.js";

export type MemoryAuthorityKind = "explicit_instruction" | "approved_decision" | "verified_outcome";
export type MemoryAuthorityClaim = {
  readonly authority_kind: MemoryAuthorityKind;
  readonly authority_id: string;
};
export type ResolvedMemoryAuthority = {
  readonly valid: true;
  readonly source: MemoryCandidateSourceMetadata;
  readonly references: readonly ParsedMemoryReference[];
  readonly claim: MemoryAuthorityClaim;
};
export type UnresolvedMemoryAuthority = { readonly valid: false };
export type MemoryAuthorityResolution = ResolvedMemoryAuthority | UnresolvedMemoryAuthority;
export type MemoryAuthorityResolverInput = {
  readonly input: ParsedMemoryCandidateInput;
  readonly identity: MemoryCandidateIdentity;
  readonly now: Date;
};
