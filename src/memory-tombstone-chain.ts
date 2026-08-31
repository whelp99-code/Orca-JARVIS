import { createHmac } from "node:crypto";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import {
  MEMORY_TOMBSTONE_GENESIS_ROOT,
  memoryEffectDigest,
  type MemoryEffectOperationV2,
  type MemoryTombstoneChainEntryV2,
  type MemoryTombstoneHighWaterV2,
  type ResolvedMemoryTargetV2,
} from "./second-brain-effect-v2.js";

export type AppendMemoryTombstoneInput = {
  readonly operation: Extract<MemoryEffectOperationV2, "correct" | "forget">;
  readonly lane_id: string;
  readonly targets: readonly ResolvedMemoryTargetV2[];
  readonly target_manifest_digest: string;
  readonly scope_digest: string;
  readonly authority_receipt_digest: string;
  readonly payload_digest: string;
  readonly effective_at: string;
};
export type AppendedMemoryTombstone = {
  readonly entry: MemoryTombstoneChainEntryV2;
  readonly high_water: MemoryTombstoneHighWaterV2;
  readonly replayed: boolean;
};

type ChainRow = MemoryTombstoneChainEntryV2 & { readonly created_at: string };

function chainEntry(row: ChainRow): MemoryTombstoneChainEntryV2 {
  return Object.freeze({
    sequence: row.sequence,
    tombstone_id: row.tombstone_id,
    operation: row.operation,
    lane_id: row.lane_id,
    target_manifest_digest: row.target_manifest_digest,
    scope_digest: row.scope_digest,
    authority_receipt_digest: row.authority_receipt_digest,
    payload_digest: row.payload_digest,
    keyed_subject_digest: row.keyed_subject_digest,
    effective_at: row.effective_at,
    previous_root: row.previous_root,
    set_root: row.set_root,
  });
}

export class MemoryTombstoneChain {
  constructor(
    private readonly authority: AuthorityDb,
    private readonly subjectKey: Buffer,
  ) {
    if (subjectKey.byteLength < 32) throw new JarvisError("MEMORY_TOMBSTONE_KEY_INVALID");
  }

  highWater(): MemoryTombstoneHighWaterV2 {
    const row = this.authority.db.prepare(
      "SELECT sequence,set_root FROM memory_tombstone_chain ORDER BY sequence DESC LIMIT 1",
    ).get() as { readonly sequence: number; readonly set_root: string } | undefined;
    return row ?? { sequence: 0, set_root: MEMORY_TOMBSTONE_GENESIS_ROOT };
  }

  delta(afterSequence: number, maximum = 256): readonly MemoryTombstoneChainEntryV2[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0
      || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256) {
      throw new JarvisError("MEMORY_TOMBSTONE_DELTA_INVALID");
    }
    const rows = this.authority.db.prepare(
      "SELECT * FROM memory_tombstone_chain WHERE sequence>? ORDER BY sequence LIMIT ?",
    ).all(afterSequence, maximum + 1) as ChainRow[];
    if (rows.length > maximum) throw new JarvisError("TOMBSTONE_DELTA_TOO_LARGE");
    return rows.map(chainEntry);
  }

  append(input: AppendMemoryTombstoneInput): AppendedMemoryTombstone {
    if (input.targets.length === 0 || input.targets.length > 64) {
      throw new JarvisError("MEMORY_TOMBSTONE_INPUT_INVALID");
    }
    return this.authority.db.transaction(() => {
      const prior = this.authority.db.prepare(
        `SELECT * FROM memory_tombstone_chain WHERE operation=? AND target_manifest_digest=?
         AND scope_digest=? AND payload_digest=?`,
      ).get(input.operation, input.target_manifest_digest, input.scope_digest,
        input.payload_digest) as ChainRow | undefined;
      if (prior !== undefined) {
        if (prior.lane_id !== input.lane_id
          || prior.authority_receipt_digest !== input.authority_receipt_digest
          || prior.effective_at !== input.effective_at) {
          throw new JarvisError("MEMORY_TOMBSTONE_REPLAY_CONFLICT");
        }
        const entry = chainEntry(prior);
        return { entry, high_water: { sequence: entry.sequence, set_root: entry.set_root }, replayed: true };
      }
      const current = this.highWater();
      const sequence = current.sequence + 1;
      const keyedSubjectDigest = `hmac-sha256:${createHmac("sha256", this.subjectKey)
        .update(input.targets.map(target => target.subject_digest).sort().join("\0"))
        .digest("hex")}`;
      const core = {
        sequence,
        operation: input.operation,
        lane_id: input.lane_id,
        target_manifest_digest: input.target_manifest_digest,
        scope_digest: input.scope_digest,
        authority_receipt_digest: input.authority_receipt_digest,
        payload_digest: input.payload_digest,
        keyed_subject_digest: keyedSubjectDigest,
        effective_at: input.effective_at,
        previous_root: current.set_root,
      };
      const setRoot = memoryEffectDigest("tombstone_chain", core);
      const entry: MemoryTombstoneChainEntryV2 = Object.freeze({
        ...core,
        tombstone_id: `memtomb:v1:${setRoot.slice(7)}`,
        set_root: setRoot,
      });
      this.authority.db.prepare(
        `INSERT INTO memory_tombstone_chain(
          sequence,tombstone_id,operation,lane_id,target_manifest_digest,scope_digest,
          authority_receipt_digest,payload_digest,keyed_subject_digest,effective_at,
          previous_root,set_root,created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(entry.sequence, entry.tombstone_id, entry.operation, entry.lane_id,
        entry.target_manifest_digest, entry.scope_digest, entry.authority_receipt_digest,
        entry.payload_digest, entry.keyed_subject_digest, entry.effective_at,
        entry.previous_root, entry.set_root, input.effective_at);
      const insertSuppression = this.authority.db.prepare(
        `INSERT INTO memory_suppressions(
          suppression_id,sequence,operation,target_digest,target_manifest_digest,scope_digest,
          keyed_subject_digest,source_identity_digest,content_identity_digest,citation_identity_digest,
          state,effective_at,created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?)`,
      );
      for (const target of input.targets) {
        const suppressionDigest = memoryEffectDigest("tombstone_chain", {
          sequence, target_digest: target.target_digest,
        });
        insertSuppression.run(`memsupp:v1:${suppressionDigest.slice(7)}`, sequence,
          input.operation, target.target_digest, input.target_manifest_digest,
          input.scope_digest, keyedSubjectDigest, target.source_identity_full,
          target.content_identity_full, target.citation_identity_full,
          input.effective_at, input.effective_at);
      }
      const targetDigests = input.targets.map(target => target.target_digest);
      if (targetDigests.length > 0) {
        const placeholders = targetDigests.map(() => "?").join(",");
        const exports = this.authority.db.prepare(
          `SELECT DISTINCT r.export_id FROM memory_export_requests r
           JOIN memory_export_target_digests t ON t.export_id=r.export_id
           WHERE r.state='available' AND t.target_digest IN (${placeholders})`,
        ).all(...targetDigests) as Array<{ readonly export_id: string }>;
        for (const managedExport of exports) {
          this.authority.db.prepare(
            `UPDATE memory_export_requests SET state='invalidated',invalidation_sequence=?,
             invalidated_at=?,updated_at=? WHERE export_id=? AND state='available'`,
          ).run(sequence, input.effective_at, input.effective_at, managedExport.export_id);
          this.authority.db.prepare(
            "UPDATE memory_export_proofs SET invalidated_at=? WHERE export_id=?",
          ).run(input.effective_at, managedExport.export_id);
        }
      }
      return { entry, high_water: { sequence, set_root: setRoot }, replayed: false };
    }).immediate();
  }

  link(sequence: number, delegationDigest: string, requestDigest: string, now: Date): void {
    const at = now.toISOString();
    const prior = this.authority.db.prepare(
      "SELECT delegation_digest,request_digest FROM memory_tombstone_delegation_links WHERE sequence=?",
    ).get(sequence) as { readonly delegation_digest: string; readonly request_digest: string } | undefined;
    if (prior !== undefined) {
      if (prior.delegation_digest !== delegationDigest || prior.request_digest !== requestDigest) {
        throw new JarvisError("MEMORY_TOMBSTONE_LINK_CONFLICT");
      }
      return;
    }
    this.authority.db.prepare(
      "INSERT INTO memory_tombstone_delegation_links(sequence,delegation_digest,request_digest,created_at) VALUES(?,?,?,?)",
    ).run(sequence, delegationDigest, requestDigest, at);
  }
}
