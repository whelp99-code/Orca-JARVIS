import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryMutationService } from "../../src/dashboard/memory-mutation-service.js";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { AuthorityDb } from "../../src/db.js";
import { MEMORY_TOMBSTONE_GENESIS_ROOT } from "../../src/second-brain-effect-v2-contract.js";
import { MemoryCorrectionSpool } from "../../src/memory-correction-spool.js";
import type { SecondBrainEvidence } from "../../src/second-brain-adapter-types.js";
import { tempDb } from "../helpers.js";

const NOW = new Date("2026-09-01T00:00:00.000Z");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function input(replacement: string) {
  return { control_request_id: "memory-control", intent_digest: `sha256:${"1".repeat(64)}`,
    semantic_digest: `sha256:${"2".repeat(64)}`, target_manifest_digest: `sha256:${"3".repeat(64)}`,
    scope_digest: `sha256:${"4".repeat(64)}`, expected_prior_digest: `sha256:${"5".repeat(64)}`,
    content_digest: `sha256:${"6".repeat(64)}`, replacement,
    created_at: NOW.toISOString(), expires_at: "2026-09-01T00:15:00.000Z" };
}

function evidence(): SecondBrainEvidence {
  return { kind: "memory", page_id: "wiki/spool", sid: "12345678", source_ref: "Second Brain",
    source_id: "src:pos:v1:second-brain:primary", source_version: "sb/0.1.0|v1|spool",
    sensitivity: "personal", observed_at: NOW.toISOString(), valid_at: NOW.toISOString(),
    freshness: { state: "fresh", checked_at: NOW.toISOString(), fresh_until: "2026-09-01T01:00:00.000Z" },
    expires_at: "2026-09-02T00:00:00.000Z", trust: "untrusted", authority: "none",
    excerpt: "Synthetic spool record", content_digest: `sha256:${"7".repeat(64)}`, omission: null,
    record: { record_id: `sbrecord:v1:${"8".repeat(64)}`, record_digest: `sha256:${"8".repeat(64)}`,
      source_identity_full: "9".repeat(64), content_identity_full: "a".repeat(64),
      citation_identity_full: "b".repeat(64), source_owner_class: "provider_owned",
      source_owner_id_digest: `sha256:${"c".repeat(64)}`, origin_label: "Second Brain",
      generation: { provider_instance_id: "provider:spool", generation_id: `sbgen:v1:${"d".repeat(64)}`,
        generation_manifest_digest: `sha256:${"e".repeat(64)}`, vault_head: "1".repeat(40),
        vault_tree: "2".repeat(40), tombstone_sequence: 0,
        tombstone_set_root: MEMORY_TOMBSTONE_GENESIS_ROOT } } };
}

describe("Task 32 correction spool publication", () => {
  it("replays exact bytes but rejects changed bytes without replacing the final inode", async () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), "task32-spool-")); roots.push(root);
    const spool = new MemoryCorrectionSpool(root);
    const first = await spool.publish(input("first replacement"));
    const before = readFileSync(first.locator);
    // When / Then
    await expect(spool.publish(input("first replacement"))).resolves.toMatchObject({ digest: first.digest });
    await expect(spool.publish(input("changed replacement")))
      .rejects.toMatchObject({ code: "MEMORY_CORRECTION_SPOOL_REPLAY_CONFLICT" });
    expect(readFileSync(first.locator)).toEqual(before);
  });

  it("publishes before authority rows so a filesystem failure leaves no staged command or attempt", async () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), "task32-spool-failure-")); roots.push(root);
    const blocked = join(root, "not-a-directory"); writeFileSync(blocked, "blocked");
    const db = new AuthorityDb(tempDb()); await db.migrate();
    const session = createDashboardSession("owner-session");
    const tokens = new MemoryTokenCache(Buffer.alloc(32, 3), () => NOW);
    const issued = tokens.issue(evidence(), session.authenticatedSessionId(), 0);
    if (issued === undefined) throw new TypeError("token issuance required");
    const service = new MemoryMutationService({ authority: db, tokens, session, clock: () => NOW,
      spool_root: blocked });
    // When
    await expect(service.stageEffect({ operation: "correct", intent_id: `memui:intent:v1:${"3".repeat(64)}`,
      token: issued.token, record_revision: issued.record_revision,
      payload: { replacement: "replacement" } })).rejects.toBeInstanceOf(Error);
    // Then
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM control_command_requests").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_surface_effect_attempts").get()).toEqual({ count: 0 });
    db.close();
  });
});
