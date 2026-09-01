import { describe, expect, it } from "vitest";
import { purgeMemoryContent } from "../../src/memory-content-purge.js";
import type {
  MemoryAuthorityCompactorPort,
  MemoryCompactionRequest,
} from "../../src/memory-compaction-types.js";
import { CompleteMemorySurfaceInventory } from "../../src/memory-managed-surface-types.js";
import {
  providerSurfaceInventory,
  reingressGuardObservations,
} from "../fixtures/memory-surface-observations.js";

class TestInventory extends CompleteMemorySurfaceInventory {
  readonly catalog_digest = `sha256:${"1".repeat(64)}`;
  readonly manifest_digest = `sha256:${"2".repeat(64)}`;
  readonly expected_surface_count = 70 as const;
  readonly observed_surface_count = 70 as const;
  readonly omission_count = 0 as const;
  readonly error_count = 0 as const;
  readonly match_count = 0 as const;
  readonly entries = [];
}

const request: MemoryCompactionRequest = {
  lane: "deletion", lane_id: `memdel:req:v1:${"3".repeat(64)}`,
  target_manifest_digest: `sha256:${"4".repeat(64)}`,
  scope_digest: `sha256:${"5".repeat(64)}`,
  tombstone: { sequence: 1, set_root: `sha256:${"6".repeat(64)}` },
  provider_inventory: providerSurfaceInventory(),
  reingress_guards: reingressGuardObservations(),
};

describe("JARVIS content propagation compatibility boundary", () => {
  it("delegates only to the fresh-file compactor without caller roots or needles", async () => {
    // Given: one typed compactor observation and the closed semantic request.
    const calls: MemoryCompactionRequest[] = [];
    const compactor: MemoryAuthorityCompactorPort = {
      async compact(value) {
        calls.push(value);
        return { purge_id: "purge:1", compaction_receipt_digest: `sha256:${"9".repeat(64)}`,
          source_generation: 1, result_generation: 2, integrity_check: "ok",
          foreign_key_errors: 0, old_database_disposed: true, old_wal_disposed: true,
          old_shm_disposed: true, old_journal_disposed: true, old_fd_count: 0,
          reader_drain_digest: `sha256:${"a".repeat(64)}`, inventory: new TestInventory() };
      },
      recover: () => Promise.resolve({ state: "reconciling", old_fd_count: 1 }),
    };

    // When: the legacy public name is used by a bounded caller.
    const result = await purgeMemoryContent({ compactor, request });

    // Then: it delegates once and returns compaction proof rather than mutating SQLite in place.
    expect(calls).toEqual([request]);
    expect(result).toMatchObject({ purge_id: "purge:1",
      receipt_digest: `sha256:${"9".repeat(64)}`,
      inventory: { expected_surface_count: 70, observed_surface_count: 70 } });
  });
});
