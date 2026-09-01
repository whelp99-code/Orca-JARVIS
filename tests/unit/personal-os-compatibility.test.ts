import { describe, expect, it } from "vitest";
import { decideRollback, migrationVectorDigest } from "../../src/personal-os-compatibility.js";

const PRIOR = [
  { id: "001", sha256: "a".repeat(64) },
  { id: "002", sha256: "b".repeat(64) },
] as const;

describe("personal-OS rollback compatibility", () => {
  it("allows rollback only when the current journal vector is in the target accepted set", () => {
    // Given
    const digest = migrationVectorDigest({
      canonical_ref: "refs/heads/whelp99-code/jarvis-personal-operating-system-linux",
      head: "a".repeat(40),
      tree: "b".repeat(40),
      migrations: PRIOR,
    });

    // When
    const decision = decideRollback({
      currentVectorDigest: digest,
      targetAcceptedDigests: [digest],
      providerContractMatch: true,
      sealedManifestMatch: true,
    });

    // Then
    expect(decision).toEqual({ kind: "allow" });
  });

  it("refuses before current changes when the vector, provider contract, or seal diverges", () => {
    // Given
    const current = migrationVectorDigest({
      canonical_ref: "refs/heads/whelp99-code/jarvis-personal-operating-system-linux",
      head: "a".repeat(40),
      tree: "b".repeat(40),
      migrations: PRIOR,
    });
    const other = migrationVectorDigest({
      canonical_ref: "refs/heads/whelp99-code/jarvis-personal-operating-system-linux",
      head: "c".repeat(40),
      tree: "d".repeat(40),
      migrations: [{ id: "001", sha256: "a".repeat(64) }],
    });

    // When
    const vector = decideRollback({
      currentVectorDigest: current,
      targetAcceptedDigests: [other],
      providerContractMatch: true,
      sealedManifestMatch: true,
    });
    const provider = decideRollback({
      currentVectorDigest: current,
      targetAcceptedDigests: [current],
      providerContractMatch: false,
      sealedManifestMatch: true,
    });
    const seal = decideRollback({
      currentVectorDigest: current,
      targetAcceptedDigests: [current],
      providerContractMatch: true,
      sealedManifestMatch: false,
    });

    // Then
    expect(vector).toEqual({ kind: "refuse", code: "RELEASE_ROLLBACK_INCOMPATIBLE" });
    expect(provider).toEqual({ kind: "refuse", code: "RELEASE_ROLLBACK_INCOMPATIBLE" });
    expect(seal).toEqual({ kind: "refuse", code: "RELEASE_ROLLBACK_INCOMPATIBLE" });
    expect(current).not.toBe(other);
  });
});
