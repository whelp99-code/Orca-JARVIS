import type { KeyObject } from "node:crypto";
import type { AuthorityDb } from "./db.js";
import type { MemoryAuthorityCompactorPort } from "./memory-compaction-types.js";
import type { MemoryLifecycleObserver } from "./memory-lifecycle-observation-types.js";
import type { MemoryLifecycleBarriers } from "./memory-lifecycle-barriers.js";
import type { SecondBrainWriteRequestAdapter } from "./second-brain-adapter-types.js";
import type { SecondBrainEffectService } from "./second-brain-effect-service.js";

export type MemorySagaRuntime = {
  readonly authority: AuthorityDb;
  readonly spool_root: string;
  readonly writer: SecondBrainWriteRequestAdapter;
  readonly provider: SecondBrainEffectService;
  readonly signing_key_id: string;
  readonly private_key: KeyObject;
  readonly subject_key: Buffer;
  readonly clock: () => Date;
  readonly observer: MemoryLifecycleObserver;
  readonly compactor: MemoryAuthorityCompactorPort;
  readonly barriers: MemoryLifecycleBarriers;
};
