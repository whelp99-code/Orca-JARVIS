import type { KeyObject } from "node:crypto";
import type { AuthorityDb } from "./db.js";
import type { MemoryCorrectionRecord } from "./memory-correction-store.js";
import type { SecondBrainWriteRequestAdapter } from "./second-brain-adapter-types.js";
import type { SecondBrainEffectService } from "./second-brain-effect-service.js";
import type { MemoryEffectScopeV2, ResolvedMemoryTargetV2 } from "./second-brain-effect-v2.js";

export type PrepareMemoryCorrectionInput = {
  readonly control_request_id: string;
  readonly candidate_id: string;
  readonly provider_instance_id: string;
  readonly targets: readonly [ResolvedMemoryTargetV2];
  readonly scope: MemoryEffectScopeV2;
  readonly content: string;
  readonly requested_at: Date;
  readonly expires_at: Date;
  readonly nonce: string;
};

export type MemoryCorrectionSagaOptions = {
  readonly authority: AuthorityDb;
  readonly spool_root: string;
  readonly writer: SecondBrainWriteRequestAdapter;
  readonly provider: SecondBrainEffectService;
  readonly signing_key_id: string;
  readonly private_key: KeyObject;
  readonly subject_key: Buffer;
  readonly clock: () => Date;
  readonly artifact_verified: (proof: Readonly<Record<string, unknown>>) => Promise<boolean>;
  readonly purge_needles: (record: MemoryCorrectionRecord) => readonly Buffer[];
  readonly managed_roots?: readonly {
    readonly path: string;
    readonly kind: "projection" | "state" | "backup" | "spool" | "restore";
  }[];
  readonly backup_roots?: readonly string[];
};
