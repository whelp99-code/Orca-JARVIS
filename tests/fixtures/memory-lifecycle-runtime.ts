import type { MemoryAuthorityCompactorPort } from "../../src/memory-compaction-types.js";
import type { AuthorityDb } from "../../src/db.js";
import type { MemoryLifecycleObserver } from "../../src/memory-lifecycle-observation-types.js";
import {
  MemoryLifecycleBarriers,
  NoopMemoryLifecycleBarrierSink,
} from "../../src/memory-lifecycle-barriers.js";

export const notProvedMemoryObserver: MemoryLifecycleObserver = {
  correction: async () => ({ kind: "not_proved", code: "TEST_PENDING" }),
  deletion: async () => ({ kind: "not_proved", code: "TEST_PENDING" }),
  export: async () => ({ kind: "not_proved", code: "TEST_PENDING" }),
};

export function noopMemoryBarriers(authority: AuthorityDb): MemoryLifecycleBarriers {
  return new MemoryLifecycleBarriers(authority, new NoopMemoryLifecycleBarrierSink());
}

export const unreachableMemoryCompactor: MemoryAuthorityCompactorPort = {
  compact: () => Promise.reject(new Error("TEST_COMPACTOR_MUST_NOT_RUN")),
  recover: () => Promise.reject(new Error("TEST_COMPACTOR_MUST_NOT_RECOVER")),
};
