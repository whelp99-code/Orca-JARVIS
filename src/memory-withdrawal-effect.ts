import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { ControlCommandRequestInput } from "./control-plane.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import {
  memoriesAwaitingTaskWithdrawal, type MemoryAwaitingWithdrawal,
} from "./memory-candidate-task-source.js";
import type { PrepareMemoryDeletionInput } from "./memory-deletion-types.js";
import { memoryCandidateSourceIdentity } from "./memory-remember-artifact.js";
import type { MemoryTargetResolver } from "./memory-target-resolver.js";
import type {
  SecondBrainReadAdapter, SecondBrainRecordBinding,
} from "./second-brain-adapter-types.js";
import type { MemoryEffectScopeV2, ResolvedMemoryTargetV2 } from "./second-brain-effect-v2.js";

const hash = (value: unknown): string => createHash("sha256")
  .update("orca-jarvis/memory-withdrawal/v1\0").update(canonicalize(value)).digest("hex");

/** Where a settled remember write actually put a candidate's material. */
export type MemoryWithdrawalDestination = {
  readonly page_id: string;
  readonly sid: string;
};

/** One stored copy whose provider target was re-resolved and verified just now. */
export type MemoryWithdrawalResolved = {
  readonly candidate_id: string;
  readonly task_id: string;
  readonly destination: MemoryWithdrawalDestination;
  readonly target: ResolvedMemoryTargetV2;
};

/** One stored copy that cannot be withdrawn on this pass, and the reason it cannot. */
export type MemoryWithdrawalRefused = {
  readonly candidate_id: string;
  readonly task_id: string;
  readonly code: string;
};

export type MemoryWithdrawalPlan = {
  /** Copies whose target the provider re-confirmed, ready for an owner-approval command. */
  readonly resolved: readonly MemoryWithdrawalResolved[];
  /** Copies the provider would not confirm. Nothing is prepared from these. */
  readonly refused: readonly MemoryWithdrawalRefused[];
  /** Candidates from hidden tasks that never reached the provider: nothing to take back. */
  readonly unstored: readonly MemoryAwaitingWithdrawal[];
};

export type MemoryWithdrawalEffectOptions = {
  readonly authority: AuthorityDb;
  /** The same bounded read the rest of the product uses; never a private channel. */
  readonly reader: SecondBrainReadAdapter;
  readonly resolver: MemoryTargetResolver;
  readonly clock: () => Date;
  /** How long the owner has to decide. Bounded by the deletion saga at fifteen minutes. */
  readonly approval_window_ms?: number;
};

/**
 * The scope one withdrawal acts in, derived from the targets rather than chosen.
 *
 * The effect contract re-checks every target against the scope it was sent under, so a scope that
 * is wider than the targets would be refused on the way out and a scope that is narrower would
 * refuse the targets. Both are avoided by computing it from the targets themselves: the classes
 * they actually carry and the validity window they actually span.
 */
export function memoryWithdrawalScope(
  targets: readonly ResolvedMemoryTargetV2[],
): MemoryEffectScopeV2 {
  const first = targets[0];
  if (first === undefined) throw new JarvisError("MEMORY_WITHDRAWAL_TARGETS_REQUIRED");
  const sensitivities = [...new Set(targets.map(target => target.sensitivity))].sort();
  const owners = [...new Set(targets.map(target => target.source_owner_class))].sort();
  const from = Math.min(...targets.map(target => Date.parse(target.valid_from)));
  const until = Math.max(...targets.map(target => Date.parse(target.valid_until)));
  if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until) {
    throw new JarvisError("MEMORY_WITHDRAWAL_TARGET_WINDOW_INVALID");
  }
  return Object.freeze({
    format: "none" as const,
    sensitivity_classes: Object.freeze(sensitivities) as MemoryEffectScopeV2["sensitivity_classes"],
    source_owner_classes: Object.freeze(owners) as MemoryEffectScopeV2["source_owner_classes"],
    valid_from: new Date(from).toISOString(), valid_until: new Date(until).toISOString(),
    max_records: targets.length, max_bytes: 4_096,
  });
}

/**
 * Turns "a hidden task still has a copy out there" into an owner-approval command.
 *
 * The list of outstanding copies names a target identity, but the deletion contract needs where
 * that record is *now* - the vault head and tree it lives under, the blob its page is, the span
 * inside that blob - and this database holds none of that, by design: the provider owns its own
 * storage. So the copy is resolved against the provider again through the read method the transport
 * contract already carries, and the answer is verified against what was recorded before anything is
 * prepared from it.
 *
 * Verification is fail-closed in every direction. An answer with fields this product does not know
 * is rejected by the target parser before it arrives here. An answer naming a different target than
 * the one the write recorded is refused, which is also what happens when the page moved on, because
 * the target identity is computed over the page's current bytes. An answer whose source identity is
 * not the candidate's own is refused, so one candidate can never point a withdrawal at another's
 * record. An answer that has already expired is refused rather than carried into an approval the
 * owner would sign for a record identity that no longer holds.
 *
 * Nothing here deletes anything or synthesises a provider effect. It stops at the command the owner
 * has to approve, and the existing deletion saga, tombstone chain and outbox do the rest.
 */
export class MemoryWithdrawalEffect {
  private readonly window: number;
  constructor(private readonly options: MemoryWithdrawalEffectOptions) {
    this.window = options.approval_window_ms ?? 10 * 60_000;
    if (!Number.isSafeInteger(this.window) || this.window < 1_000 || this.window > 15 * 60_000) {
      throw new JarvisError("MEMORY_WITHDRAWAL_CONFIG_INVALID");
    }
  }

  /** Everything a hidden task still has stored, target identity included. */
  pending(): readonly MemoryAwaitingWithdrawal[] {
    return memoriesAwaitingTaskWithdrawal(this.options.authority);
  }

  /**
   * Where the product's own dispatch put this candidate's material.
   *
   * Taken from the settled outbox row rather than from a caller: the destination is derived by the
   * write path from the candidate and the content, and a withdrawal that read it from anywhere else
   * could be aimed at a page this candidate never wrote to.
   */
  destination(candidateId: string): MemoryWithdrawalDestination | undefined {
    const row = this.options.authority.db.prepare(
      `SELECT expected_page_id AS page_id,expected_sid AS sid FROM memory_outbox
       WHERE candidate_id=? AND operation='remember' AND state='settled'`,
    ).get(candidateId);
    if (row === null || row === undefined || typeof row !== "object") return undefined;
    const pageId = Reflect.get(row, "page_id");
    const sid = Reflect.get(row, "sid");
    if (typeof pageId !== "string" || pageId.length === 0
      || typeof sid !== "string" || sid.length === 0) return undefined;
    return Object.freeze({ page_id: pageId, sid });
  }

  /** The whole outstanding list, resolved against the provider one entry at a time. */
  async plan(): Promise<MemoryWithdrawalPlan> {
    const resolved: MemoryWithdrawalResolved[] = [];
    const refused: MemoryWithdrawalRefused[] = [];
    const unstored: MemoryAwaitingWithdrawal[] = [];
    for (const entry of this.pending()) {
      if (entry.target_id === null || entry.target_digest === null) { unstored.push(entry); continue; }
      const outcome = await this.resolve(entry);
      if (outcome.kind === "resolved") resolved.push(outcome.value); else refused.push(outcome.value);
    }
    return Object.freeze({ resolved, refused, unstored });
  }

  /** Re-resolve exactly one outstanding copy and verify the answer against what was recorded. */
  async resolve(entry: MemoryAwaitingWithdrawal): Promise<
    | { readonly kind: "resolved"; readonly value: MemoryWithdrawalResolved }
    | { readonly kind: "refused"; readonly value: MemoryWithdrawalRefused }
  > {
    const refuse = (code: string) => ({ kind: "refused" as const,
      value: Object.freeze({ candidate_id: entry.candidate_id, task_id: entry.task_id, code }) });
    if (entry.target_id === null || entry.target_digest === null) {
      return refuse("MEMORY_WITHDRAWAL_NOT_STORED");
    }
    const destination = this.destination(entry.candidate_id);
    if (destination === undefined) return refuse("MEMORY_WITHDRAWAL_DESTINATION_UNKNOWN");
    const sourceIdentity = memoryCandidateSourceIdentity(entry.candidate_id);
    const page = await this.options.reader.readPage(destination.page_id);
    // Only a current read may aim a withdrawal: a stale, conflicted or unavailable page is not
    // evidence of where the record is now.
    if (page.kind !== "current") {
      return refuse(page.kind === "invalid" || page.kind === "unavailable" || page.kind === "offline"
        ? page.code : `MEMORY_WITHDRAWAL_PAGE_${page.kind.toUpperCase()}`);
    }
    const record: SecondBrainRecordBinding | undefined = page.evidence
      .find(item => item.sid === destination.sid && item.record !== null
        && item.record.source_identity_full === sourceIdentity)?.record ?? undefined;
    if (record === null || record === undefined) return refuse("MEMORY_WITHDRAWAL_RECORD_ABSENT");
    const result = await this.options.resolver.resolve({ record_id: record.record_id,
      record_digest: record.record_digest, generation_id: record.generation.generation_id,
      generation_manifest_digest: record.generation.generation_manifest_digest });
    if (result.kind !== "data") return refuse(result.code);
    const target = result.value;
    if (target.target_id !== entry.target_id || target.target_digest !== entry.target_digest) {
      return refuse("MEMORY_WITHDRAWAL_TARGET_CHANGED");
    }
    if (target.source_identity_full !== sourceIdentity) {
      return refuse("MEMORY_WITHDRAWAL_SOURCE_IDENTITY_MISMATCH");
    }
    if (target.content_identity_full !== record.content_identity_full
      || target.citation_identity_full !== record.citation_identity_full) {
      return refuse("MEMORY_WITHDRAWAL_CONTENT_IDENTITY_MISMATCH");
    }
    if (target.page_id !== destination.page_id) {
      return refuse("MEMORY_WITHDRAWAL_PAGE_MISMATCH");
    }
    if (Date.parse(target.expires_at) <= this.options.clock().getTime()) {
      return refuse("MEMORY_WITHDRAWAL_TARGET_EXPIRED");
    }
    return { kind: "resolved", value: Object.freeze({ candidate_id: entry.candidate_id,
      task_id: entry.task_id, destination, target }) };
  }

  /**
   * The owner-approval command for one verified copy.
   *
   * One command per copy, because the deletion contract requires every target in a request to share
   * one provider generation and separate copies are resolved separately. The command is produced by
   * the existing deletion preparation, which is what binds it to a spool, a lane and an idempotency
   * key - this only supplies the input it asks for.
   */
  prepare(
    entry: MemoryWithdrawalResolved,
    prepareDeletion: (input: PrepareMemoryDeletionInput) => Promise<ControlCommandRequestInput>,
  ): Promise<ControlCommandRequestInput> {
    const requestedAt = this.options.clock();
    const identity = hash({ candidate_id: entry.candidate_id, task_id: entry.task_id,
      target_digest: entry.target.target_digest, requested_at: requestedAt.toISOString() });
    return prepareDeletion({
      deletion_id: `memdel:withdraw:v1:${identity}`,
      correlation_id: `corr:memory-withdrawal:${identity}`,
      provider_instance_id: entry.target.provider_instance_id,
      targets: [entry.target], scope: memoryWithdrawalScope([entry.target]),
      // The provider owns this record, so the erasure claim is the managed one and there is no
      // external owner to produce a receipt for.
      erasure_claim: entry.target.source_owner_class === "provider_owned"
        ? "managed_erasure" : "provider_local_suppression",
      external_receipts: [], requested_at: requestedAt,
      expires_at: new Date(requestedAt.getTime() + this.window),
      nonce: `memwdl:nonce:v1:${identity}`,
    });
  }
}
