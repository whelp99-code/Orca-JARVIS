import { canonicalize } from "./canonical.js";
import { MemoryReferenceDeliveries, type MemoryReferenceSession } from "./memory-reference-deliveries.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { memoryReadPrivacyState, isMemoryReadSuppressed, type MemoryMembership } from "./memory-read-privacy.js";
import { prepareMemoryReference, MemoryReferenceError, type MemoryReferenceBudgets, type PreparedMemoryReference } from "./memory-reference-context.js";
import type { SecondBrainReadAdapter, SecondBrainGenerationBinding } from "./second-brain-adapter-types.js";
import type { SecondBrainOutcome } from "./second-brain-transport.js";

export type MemoryReferenceReaderOptions = {
  readonly authority: AuthorityDb; readonly adapter: Pick<SecondBrainReadAdapter, "search">;
  readonly membership: MemoryMembership; readonly clock: () => Date;
  readonly generation_status: () => Promise<SecondBrainOutcome>;
  readonly assert_authorized?: (at: Date) => void;
};
export type CheckedMemoryReference = PreparedMemoryReference & {
  /** Local receipt time of the final status response, not a perpetual freshness guarantee. */
  readonly provider_status_received_at: string;
};
type Submission = {
  readonly fingerprint: string; readonly privacy: string;
  readonly generation: SecondBrainGenerationBinding;
  readonly serialized: string; readonly prepared_at: string; readonly fresh_until: string;
  attempted: boolean;
};

/** Explicit local owner read, not an agent delivery receipt or project authorization. */
export class MemoryReferenceReader {
  private readonly submissions = new WeakMap<CheckedMemoryReference, Submission>();
  constructor(private readonly options: MemoryReferenceReaderOptions) {}

  /** One local submission attempt of a reader-issued reference. This is not a
   * durable/native client receipt and cannot retract bytes already submitted. */
  async submit<T>(reference: CheckedMemoryReference, send: (serialized: string) => Promise<T>): Promise<T> {
    return this.submitChecked(reference, send);
  }

  /** Durable session claim. The adapter must provide observed session/epoch identity. */
  async submitInSession<T>(reference: CheckedMemoryReference, send: (serialized: string) => Promise<T>,
    session: MemoryReferenceSession): Promise<T> {
    if (session === undefined || session === null) throw new JarvisError("MEMORY_REFERENCE_SESSION_INVALID");
    return this.submitChecked(reference, send, session);
  }

  private async submitChecked<T>(reference: CheckedMemoryReference, send: (serialized: string) => Promise<T>,
    session?: MemoryReferenceSession): Promise<T> {
    const submission = this.submissions.get(reference);
    if (submission === undefined || submission.attempted || typeof send !== "function") {
      throw new JarvisError("MEMORY_REFERENCE_SUBMISSION_INVALID");
    }
    // Claim before the first await: concurrent calls and uncertain retries cannot send twice.
    submission.attempted = true;
    const before = await this.submissionStatus();
    this.validateSubmission(reference, submission, before);
    const journal = new MemoryReferenceDeliveries(this.options.authority, this.options.membership);
    const frozenPayload = JSON.parse(submission.serialized) as CheckedMemoryReference["payload"];
    const attempt = session === undefined ? null : journal.claim(session,
      canonicalize({ generation: submission.generation, privacy: submission.privacy }),
      canonicalize(frozenPayload.records.map(row => [row.record.record_id, row.record.record_digest]).sort()),
      submission.serialized, this.options.clock(), submission.privacy,
      () => this.validateSubmissionState(submission, before));
    let result: T;
    try { result = await send(submission.serialized); }
    catch {
      if (attempt !== null && journal.status(attempt)?.state !== "invalidated") {
        try { journal.finish(attempt, "unconfirmed", this.options.clock()); }
        catch { if (journal.status(attempt)?.state !== "invalidated") throw new JarvisError("MEMORY_REFERENCE_JOURNAL_UNAVAILABLE"); }
      }
      throw new JarvisError("MEMORY_REFERENCE_SUBMISSION_UNCONFIRMED");
    }
    try {
      const after = await this.submissionStatus();
      this.validateSubmission(reference, submission, after);
      if (attempt !== null) journal.finish(attempt, "callback_completed", this.options.clock(),
        () => this.validateSubmissionState(submission, after));
    } catch (error) {
      if (attempt !== null) journal.invalidate(attempt, this.options.clock());
      throw error;
    }
    return result;
  }

  private async submissionStatus(): Promise<SecondBrainOutcome> {
    try { return await this.options.generation_status(); }
    catch (error) {
      if (error instanceof JarvisError) throw error;
      throw new JarvisError("MEMORY_REFERENCE_PROVIDER_UNAVAILABLE");
    }
  }

  private validateSubmission(reference: CheckedMemoryReference, submission: Submission,
    status: SecondBrainOutcome): void {
    const { authority } = this.options;
    // Caller-owned objects may contain cycles/getters. Never run those inside a DB transaction.
    try {
      if (canonicalize(reference) !== submission.fingerprint) throw new Error();
    } catch { throw new JarvisError("MEMORY_REFERENCE_SUBMISSION_INVALID"); }
    try { authority.db.transaction(() => {
      this.validateSubmissionState(submission, status);
    })(); } catch (error) {
      if (error instanceof JarvisError) throw error;
      throw new JarvisError("MEMORY_REFERENCE_PRIVACY_UNAVAILABLE");
    }
  }

  private validateSubmissionState(submission: Submission, status: SecondBrainOutcome): void {
    const { authority, clock } = this.options;
      const privacy = memoryReadPrivacyState(authority);
      if (canonicalize(privacy) !== submission.privacy) throw new JarvisError("MEMORY_REFERENCE_PRIVACY_CHANGED");
      const now = clock();
      this.options.assert_authorized?.(now);
      if (!Number.isFinite(now.getTime()) || now.getTime() < Date.parse(submission.prepared_at)
        || !Number.isFinite(Date.parse(submission.fresh_until))
        || now.getTime() >= Date.parse(submission.fresh_until)) {
        throw new JarvisError("MEMORY_REFERENCE_EXPIRED");
      }
      if (!matchesStatus(status, submission.generation, privacy.tombstone_sequence, privacy.tombstone_set_root)) {
        throw new JarvisError("MEMORY_REFERENCE_GENERATION_CHANGED");
      }
  }

  async read(query: string, budgets: MemoryReferenceBudgets,
    releaseProvider?: () => Promise<void>): Promise<CheckedMemoryReference> {
    const { authority, adapter, clock } = this.options;
    const now = clock();
    // Validate query and the empty envelope budget before making any provider call.
    prepareMemoryReference({ query, budgets, now, outcome: { kind: "no_data",
      checked_at: now.toISOString(), fresh_until: now.toISOString() } });
    const initial = memoryReadPrivacyState(authority);
    let outcome: Awaited<ReturnType<SecondBrainReadAdapter["search"]>>;
    let status: SecondBrainOutcome;
    let generation: SecondBrainGenerationBinding;
    let statusReceivedAt: string;
    try {
      const before = await this.options.generation_status();
      if (!matchesStatus(before, undefined, initial.tombstone_sequence, initial.tombstone_set_root)
        || before.kind !== "data") throw new JarvisError("MEMORY_REFERENCE_GENERATION_CHANGED");
      generation = {
        provider_instance_id: String(before.value["provider_instance_id"]),
        generation_id: String(before.value["generation_id"]),
        generation_manifest_digest: String(before.value["generation_manifest_digest"]),
        vault_head: String(before.value["vault_head"]), vault_tree: String(before.value["vault_tree"]),
        tombstone_sequence: initial.tombstone_sequence, tombstone_set_root: initial.tombstone_set_root,
      };
      outcome = await adapter.search(query);
      if (outcome.kind !== "current" && outcome.kind !== "no_data") {
        throw new JarvisError("MEMORY_REFERENCE_PROVIDER_UNAVAILABLE");
      }
      status = await this.options.generation_status();
      statusReceivedAt = clock().toISOString();
      // CLI-owned transport shutdown can take time. Complete it before the final
      // local privacy/freshness transaction; this callback receives no content.
      await releaseProvider?.();
    } catch (error) {
      if (error instanceof JarvisError) throw error;
      throw new JarvisError("MEMORY_REFERENCE_PROVIDER_UNAVAILABLE");
    }
    try { return authority.db.transaction(() => {
      const final = memoryReadPrivacyState(authority);
      if (canonicalize(initial) !== canonicalize(final)) throw new JarvisError("MEMORY_REFERENCE_PRIVACY_CHANGED");
      this.options.assert_authorized?.(clock());
      if (!matchesStatus(status, generation, final.tombstone_sequence, final.tombstone_set_root)) {
        throw new JarvisError("MEMORY_REFERENCE_GENERATION_CHANGED");
      }
      if (outcome.kind === "current") {
        // The entire reference is withheld when a local suppression matches. This
        // avoids emitting blocked identities or disguising that fact as no_data.
        for (const item of outcome.evidence) {
          if (item.record === null) throw new JarvisError("MEMORY_REFERENCE_BINDING_INVALID");
          if (!matchesStatus(status, item.record.generation, final.tombstone_sequence, final.tombstone_set_root)) {
            throw new JarvisError("MEMORY_REFERENCE_GENERATION_CHANGED");
          }
          if (isMemoryReadSuppressed(authority, item, this.options.membership)) {
            throw new JarvisError("MEMORY_REFERENCE_SUPPRESSED");
          }
        }
      }
      const reference = { ...prepareMemoryReference({ query, budgets, outcome, now: clock() }),
        provider_status_received_at: statusReceivedAt };
      this.submissions.set(reference, { fingerprint: canonicalize(reference), privacy: canonicalize(final),
        generation: { ...generation }, serialized: reference.serialized,
        prepared_at: reference.payload.prepared_at,
        fresh_until: new Date(Math.min(Date.parse(outcome.checked_at) + 60_000,
          outcome.kind === "no_data" ? Date.parse(outcome.fresh_until) : Infinity,
          reference.payload.fresh_until === null ? Infinity : Date.parse(reference.payload.fresh_until))).toISOString(),
        attempted: false });
      return reference;
    })(); } catch (error) {
      if (error instanceof JarvisError || error instanceof MemoryReferenceError) throw error;
      throw new JarvisError("MEMORY_REFERENCE_PRIVACY_UNAVAILABLE");
    }
  }
}

function matchesStatus(status: SecondBrainOutcome, expected: SecondBrainGenerationBinding | undefined,
  sequence: number, root: string): boolean {
  if (status.kind !== "data") return false;
  const value = status.value;
  if (value["schema_version"] !== 1 || value["pointer_health"] !== "healthy" || value["journal_health"] !== "healthy"
    || value["tombstone_sequence"] !== sequence || value["tombstone_set_root"] !== root
    || typeof value["provider_instance_id"] !== "string" || value["provider_instance_id"].length === 0
    || typeof value["generation_id"] !== "string" || !/^sbgen:v1:[0-9a-f]{64}$/.test(value["generation_id"])
    || typeof value["generation_manifest_digest"] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value["generation_manifest_digest"])
    || typeof value["vault_head"] !== "string" || !/^[0-9a-f]{40}$/.test(value["vault_head"])
    || typeof value["vault_tree"] !== "string" || !/^[0-9a-f]{40}$/.test(value["vault_tree"])) return false;
  return expected === undefined || Object.entries(expected).every(([key, item]) => value[key] === item);
}
