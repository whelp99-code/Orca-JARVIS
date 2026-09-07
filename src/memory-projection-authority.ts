import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { MemoryProjectionLineage } from "./memory-projection-lineage.js";
import type {
  MemoryProjectionDatabase,
  MemoryProjectionDependency,
  MemoryProjectionRef,
  MemorySuppressionActivation,
  MemorySuppressionEvent,
} from "./memory-projection-types.js";

const digest = (value: unknown): string => `sha256:${createHash("sha256")
  .update("orca-jarvis/memory-projection-suppression/v1\0")
  .update(canonicalize(value)).digest("hex")}`;

export class MemoryProjectionAuthority {
  private readonly lineage: MemoryProjectionLineage;

  constructor(private readonly authority: MemoryProjectionDatabase) {
    this.lineage = new MemoryProjectionLineage(authority);
  }

  initialize(now: Date): void {
    this.lineage.initialize(now);
  }

  private write<T>(action: () => T): T {
    return this.authority.db.transaction(() => { this.assertReady(); return action(); }).immediate();
  }

  bind(ref: MemoryProjectionRef, identities: readonly MemoryProjectionDependency[], now: Date): void {
    this.write(() => this.lineage.bind(ref, identities, now));
  }

  inherit(ref: MemoryProjectionRef, parents: readonly MemoryProjectionRef[], now: Date): void {
    this.write(() => this.lineage.inherit(ref, parents, now));
  }

  hasLineage(ref: MemoryProjectionRef): boolean {
    this.assertReady();
    return this.lineage.hasLineage(ref);
  }

  quarantineUnresolved(ref: MemoryProjectionRef, now: Date): void {
    this.write(() => this.lineage.quarantineUnresolved(ref, now));
  }

  isSuppressed(ref: MemoryProjectionRef): boolean {
    this.assertReady();
    if (this.lineage.isQuarantined(ref)) return true;
    return this.authority.db.prepare(
      `SELECT 1 FROM memory_projection_suppressions
       WHERE projection_kind=? AND projection_id=? AND component_id=? LIMIT 1`,
    ).get(ref.kind, ref.id, ref.component_id) !== undefined;
  }

  isProjectionIdSuppressed(id: string): boolean {
    this.assertReady();
    if (id.length === 0) return true;
    return this.authority.db.prepare(
      `SELECT 1 FROM memory_projection_suppressions WHERE projection_id=?
       UNION ALL SELECT 1 FROM memory_projection_quarantine WHERE projection_id=? LIMIT 1`,
    ).get(id, id) !== undefined;
  }

  visible<T>(rows: readonly T[], ref: (row: T) => MemoryProjectionRef): readonly T[] {
    this.assertReady();
    return rows.filter(row => !this.isSuppressed(ref(row)));
  }

  activateForSequence(sequence: number): MemorySuppressionActivation {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new JarvisError("MEMORY_PROJECTION_SEQUENCE_INVALID");
    }
    return this.authority.db.transaction(() => {
      this.assertReady();
      const existing = this.event(sequence);
      if (existing !== undefined) return existing;
      const createdAt = this.tombstoneTime(sequence);
      this.lineage.quarantineUnresolvedMemory(new Date(createdAt));
      this.authority.db.prepare(
        `INSERT OR IGNORE INTO memory_projection_suppressions(
          sequence,projection_kind,projection_id,component_id,suppression_id,effective_at
         )
         SELECT s.sequence,d.projection_kind,d.projection_id,d.component_id,s.suppression_id,s.effective_at
         FROM memory_suppressions s JOIN memory_projection_dependencies d ON
           d.target_digest=s.target_digest
           OR (d.keyed_subject_digest IS NOT NULL AND d.keyed_subject_digest=s.keyed_subject_digest)
           OR (d.source_identity_digest IS NOT NULL AND d.source_identity_digest=s.source_identity_digest)
           OR (d.content_identity_digest IS NOT NULL AND d.content_identity_digest=s.content_identity_digest)
           OR (d.citation_identity_digest IS NOT NULL AND d.citation_identity_digest=s.citation_identity_digest)
         WHERE s.sequence=?`,
      ).run(sequence);
      this.suppressNotifications(sequence);
      const row = this.authority.db.prepare(
        `SELECT COUNT(DISTINCT projection_kind||char(0)||projection_id||char(0)||component_id) AS count,
                MIN(effective_at) AS effective_at
         FROM memory_projection_suppressions WHERE sequence=?`,
      ).get(sequence) as { readonly count: number; readonly effective_at: string | null };
      const eventTime = row.effective_at ?? createdAt;
      const eventDigest = digest({ sequence, projection_count: row.count, created_at: eventTime });
      this.authority.db.prepare(
        `INSERT INTO memory_suppression_events(
          sequence,event_digest,projection_count,created_at,published_at
         ) VALUES(?,?,?,?,NULL)`,
      ).run(sequence, eventDigest, row.count, eventTime);
      return { sequence, projection_count: row.count,
        event_digest: eventDigest, created_at: eventTime };
    }).immediate();
  }

  markPublished(sequence: number, now: Date): MemorySuppressionEvent {
    const changed = this.authority.db.prepare(
      "UPDATE memory_suppression_events SET published_at=? WHERE sequence=? AND published_at IS NULL",
    ).run(now.toISOString(), sequence);
    const event = this.event(sequence);
    if (event === undefined || (changed.changes === 0 && event.published_at === null)) {
      throw new JarvisError("MEMORY_SUPPRESSION_EVENT_NOT_FOUND");
    }
    return event;
  }

  assertReady(): void {
    this.lineage.assertReady();
  }

  private suppressNotifications(sequence: number): void {
    const effectiveAt = this.tombstoneTime(sequence);
    this.authority.db.prepare(
      `UPDATE notification_deliveries SET state='failed',updated_at=?
       WHERE state='delivering' AND (delivery_id IN (
         SELECT projection_id FROM memory_projection_suppressions
         WHERE sequence=? AND projection_kind='notification_delivery'
       ) OR intent_id IN (
         SELECT projection_id FROM memory_projection_suppressions
         WHERE sequence=? AND projection_kind='notification_intent'
       ))`,
    ).run(effectiveAt, sequence, sequence);
    this.authority.db.prepare(
      `UPDATE notification_intents SET state='failed',updated_at=? WHERE state='delivering'
       AND intent_id IN (SELECT projection_id FROM memory_projection_suppressions
         WHERE sequence=? AND projection_kind='notification_intent')`,
    ).run(effectiveAt, sequence);
    this.authority.db.prepare(
      `UPDATE notification_intents SET state='suppressed',updated_at=?
       WHERE intent_id IN (SELECT projection_id FROM memory_projection_suppressions
         WHERE sequence=? AND projection_kind='notification_intent')
       AND state IN ('created','deferred','queued')`,
    ).run(effectiveAt, sequence);
  }

  private event(sequence: number): MemorySuppressionEvent | undefined {
    return this.authority.db.prepare(
      `SELECT sequence,event_digest,projection_count,created_at,published_at
       FROM memory_suppression_events WHERE sequence=?`,
    ).get(sequence) as MemorySuppressionEvent | undefined;
  }

  private tombstoneTime(sequence: number): string {
    const row = this.authority.db.prepare(
      "SELECT effective_at FROM memory_tombstone_chain WHERE sequence=?",
    ).get(sequence) as { readonly effective_at: string } | undefined;
    if (row === undefined) throw new JarvisError("MEMORY_PROJECTION_SEQUENCE_INVALID");
    return row.effective_at;
  }
}
