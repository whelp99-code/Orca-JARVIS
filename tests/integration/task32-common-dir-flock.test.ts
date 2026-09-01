import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCorrectionSpool } from "../../src/memory-correction-spool.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function spool(): MemoryCorrectionSpool {
  const root = mkdtempSync(join(tmpdir(), "task32-correction-spool-"));
  roots.push(root);
  return new MemoryCorrectionSpool(root);
}

function publication(replacement: string) {
  return { control_request_id: "memui-control-v1-aaaa", intent_digest: `sha256:${"1".repeat(64)}`,
    semantic_digest: `sha256:${"2".repeat(64)}`, target_manifest_digest: `sha256:${"3".repeat(64)}`,
    scope_digest: `sha256:${"4".repeat(64)}`, expected_prior_digest: `sha256:${"5".repeat(64)}`,
    content_digest: `sha256:${"6".repeat(64)}`, replacement,
    created_at: "2026-09-01T00:00:00.000Z", expires_at: "2026-09-01T00:15:00.000Z" };
}

describe("Task 32 correction spool publication barrier", () => {
  it("treats an identical same-path replay as an idempotent no-op", async () => {
    // Given a published correction
    const subject = spool();
    const first = await subject.publish(publication("corrected text"));
    const before = statSync(first.locator).ino;
    // When the identical command is replayed
    const replay = await subject.publish(publication("corrected text"));
    // Then the same inode is reused and no second file is created
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(statSync(replay.locator).ino).toBe(before);
  });

  it("refuses a changed-byte replay rather than overwriting the published inode", async () => {
    // Given a published correction
    const subject = spool();
    const first = await subject.publish(publication("corrected text"));
    const before = statSync(first.locator).ino;
    // When the same command path is replayed with different bytes
    const changed = subject.publish(publication("attacker replacement"));
    // Then the replay is rejected and the original inode survives untouched
    await expect(changed).rejects.toThrow("MEMORY_CORRECTION_SPOOL_REPLAY_CONFLICT");
    expect(statSync(first.locator).ino).toBe(before);
  });

  it("compensates a publication by removing only its own file", async () => {
    // Given a published correction
    const subject = spool();
    const published = await subject.publish(publication("corrected text"));
    // When the caller compensates the failed transaction
    await subject.compensate(published);
    // Then the published locator no longer exists
    expect(() => statSync(published.locator)).toThrow();
  });
});
