import { describe, expect, it } from "vitest";
import { bindSecondBrainGenerationRead } from "../../src/second-brain-generation-read.js";

const generation = {
  provider_instance_id: "provider:task32",
  generation_id: `sbgen:v1:${"e".repeat(64)}`,
  generation_manifest_digest: `sha256:${"f".repeat(64)}`,
  vault_head: "1".repeat(40),
  vault_tree: "2".repeat(40),
  tombstone_sequence: 0,
  tombstone_set_root: `sha256:${"3".repeat(64)}`,
} as const;

const session = () => ({
  fence: undefined, method: "sb_search" as const,
  unbound_generations: new Map<"sb_search", string>(),
});

describe("Task 32 generation race binding", () => {
  it("rejects a provider response whose generation identity changes mid-session", () => {
    // Given one provider session that already bound a generation
    const context = session();
    const accepted = bindSecondBrainGenerationRead({ ...generation, results: [] }, context);
    // When the same session reports a different vault head
    const changed = bindSecondBrainGenerationRead(
      { ...generation, vault_head: "4".repeat(40), results: [] }, context);
    // Then the first binding stands and the flapped one is refused
    expect(accepted).toBeDefined();
    expect(changed).toBeUndefined();
  });

  it("admits an independent session reporting its own generation identity", () => {
    // Given a session that bound one generation
    bindSecondBrainGenerationRead({ ...generation, results: [] }, session());
    // When a separate session reports a different generation
    const other = bindSecondBrainGenerationRead(
      { ...generation, vault_head: "4".repeat(40), results: [] }, session());
    // Then it is accepted, proving the memo is not process-global
    expect(other).toBeDefined();
  });
});
