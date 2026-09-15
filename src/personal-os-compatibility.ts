import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";

export type MigrationEntry = {
  readonly id: string;
  readonly sha256: string;
};

/** The branch a Linux authority migration vector is computed against. */
export const MIGRATION_VECTOR_CANONICAL_REF =
  "refs/heads/whelp99-code/jarvis-personal-operating-system-linux" as const;

export type MigrationVectorInput = {
  readonly canonical_ref: string;
  readonly head: string;
  readonly tree: string;
  readonly migrations: readonly MigrationEntry[];
};

export type RollbackDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "refuse"; readonly code: "RELEASE_ROLLBACK_INCOMPATIBLE" };

export function migrationVectorDigest(input: MigrationVectorInput): string {
  const preimage = canonicalize({
    schema_version: 1,
    canonical_ref: input.canonical_ref,
    head: input.head,
    tree: input.tree,
    migrations: input.migrations,
  });
  return createHash("sha256").update("orca-jarvis/migration-vector/v1\0").update(preimage).digest("hex");
}

export function decideRollback(input: {
  readonly currentVectorDigest: string;
  readonly targetAcceptedDigests: readonly string[];
  readonly providerContractMatch: boolean;
  readonly sealedManifestMatch: boolean;
}): RollbackDecision {
  if (!input.providerContractMatch || !input.sealedManifestMatch) {
    return { kind: "refuse", code: "RELEASE_ROLLBACK_INCOMPATIBLE" };
  }
  if (!input.targetAcceptedDigests.includes(input.currentVectorDigest)) {
    return { kind: "refuse", code: "RELEASE_ROLLBACK_INCOMPATIBLE" };
  }
  return { kind: "allow" };
}
