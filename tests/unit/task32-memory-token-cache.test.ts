import { describe, expect, it } from "vitest";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import type { SecondBrainEvidence } from "../../src/second-brain-adapter-types.js";

const NOW = new Date("2026-09-01T00:00:00.000Z");
const DIGEST = `sha256:${"1".repeat(64)}`;

function evidence(): SecondBrainEvidence {
  return { kind: "memory", page_id: "wiki/token", sid: "12345678", source_ref: "Second Brain",
    source_id: "src:pos:v1:second-brain:primary", source_version: "sb/0.1.0|v1|token",
    sensitivity: "personal", observed_at: NOW.toISOString(), valid_at: NOW.toISOString(),
    freshness: { state: "fresh", checked_at: NOW.toISOString(), fresh_until: "2026-09-01T01:00:00.000Z" },
    expires_at: "2026-09-02T00:00:00.000Z", trust: "untrusted", authority: "none",
    excerpt: "Synthetic token record", content_digest: DIGEST, omission: null,
    record: { record_id: `sbrecord:v1:${"2".repeat(64)}`, record_digest: `sha256:${"2".repeat(64)}`,
      source_identity_full: "3".repeat(64), content_identity_full: "4".repeat(64),
      citation_identity_full: "5".repeat(64), source_owner_class: "provider_owned",
      source_owner_id_digest: `sha256:${"6".repeat(64)}`, origin_label: "Second Brain",
      generation: { provider_instance_id: "provider:token", generation_id: `sbgen:v1:${"7".repeat(64)}`,
        generation_manifest_digest: `sha256:${"8".repeat(64)}`, vault_head: "9".repeat(40),
        vault_tree: "a".repeat(40), tombstone_sequence: 11,
        tombstone_set_root: `sha256:${"b".repeat(64)}` } } };
}

describe("Task 32 one-time Memory record tokens", () => {
  it("binds every frozen authority dimension and rejects replay", () => {
    // Given
    const cache = new MemoryTokenCache(Buffer.alloc(32, 7), () => NOW);
    const issued = cache.issue(evidence(), "owner-session", 3);
    if (issued === undefined) throw new TypeError("token issuance required");
    // When
    const first = cache.get(issued.token, "owner-session", 3);
    const replay = cache.get(issued.token, "owner-session", 3);
    // Then
    expect(first).toMatchObject({ vault_head: "9".repeat(40), vault_tree: "a".repeat(40),
      tombstone_sequence: 11, tombstone_set_root: `sha256:${"b".repeat(64)}`,
      policy_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), sensitivity: "personal",
      source_owner_class: "provider_owned", owner_session_id: "owner-session",
      session_incarnation: "owner-session" });
    expect(replay).toBeUndefined();
  });

  it("rejects at expiry equality", () => {
    // Given
    let now = NOW;
    const cache = new MemoryTokenCache(Buffer.alloc(32, 8), () => now);
    const issued = cache.issue(evidence(), "owner-session", 3);
    if (issued === undefined) throw new TypeError("token issuance required");
    // When
    now = new Date(NOW.getTime() + 300_000);
    const result = cache.get(issued.token, "owner-session", 3);
    // Then
    expect(result).toBeUndefined();
  });
});
