import type { KeyObject } from "node:crypto";
import type { AuthorityDb } from "./db.js";
import type { MemoryDeletionRecord } from "./memory-deletion-store.js";
import type { SecondBrainWriteRequestAdapter } from "./second-brain-adapter-types.js";
import type { SecondBrainEffectService } from "./second-brain-effect-service.js";
import type {
  ExternalErasureReceiptV2,
  MemoryEffectScopeV2,
  ResolvedMemoryTargetV2,
} from "./second-brain-effect-v2.js";

export type PrepareMemoryDeletionInput = {
  readonly deletion_id: string;
  readonly correlation_id: string;
  readonly provider_instance_id: string;
  readonly targets: readonly ResolvedMemoryTargetV2[];
  readonly scope: MemoryEffectScopeV2;
  readonly erasure_claim: "managed_erasure" | "provider_local_suppression";
  readonly external_receipts: readonly ExternalErasureReceiptV2[];
  readonly requested_at: Date;
  readonly expires_at: Date;
  readonly nonce: string;
};

export type MemoryDeletionSagaOptions = {
  readonly authority: AuthorityDb;
  readonly spool_root: string;
  readonly writer: SecondBrainWriteRequestAdapter;
  readonly provider: SecondBrainEffectService;
  readonly signing_key_id: string;
  readonly private_key: KeyObject;
  readonly subject_key: Buffer;
  readonly clock: () => Date;
  readonly absence_verified: (proof: Readonly<Record<string, unknown>>) => Promise<boolean>;
  readonly purge_needles: (record: MemoryDeletionRecord) => readonly Buffer[];
  readonly managed_roots?: readonly {
    readonly path: string;
    readonly kind: "projection" | "state" | "backup" | "spool" | "restore";
  }[];
  readonly backup_roots?: readonly string[];
};
