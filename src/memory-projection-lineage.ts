import { JarvisError } from "./db.js";
import {
  MEMORY_PROJECTION_KINDS,
  type MemoryProjectionDatabase,
  type MemoryProjectionDependency,
  type MemoryProjectionRef,
} from "./memory-projection-types.js";

type DependencyRow = {
  readonly target_digest: string;
  readonly keyed_subject_digest: string | null;
  readonly source_identity_digest: string | null;
  readonly content_identity_digest: string | null;
  readonly citation_identity_digest: string | null;
  readonly source_context_id: string | null;
};

type TargetRow = {
  readonly target_digest: string;
  readonly keyed_subject_digest: string;
  readonly source_identity_digest: string;
  readonly content_identity_digest: string;
  readonly citation_identity_digest: string;
};

export class MemoryProjectionLineage {
  constructor(private readonly authority: MemoryProjectionDatabase) {}

  bind(ref: MemoryProjectionRef, identities: readonly MemoryProjectionDependency[], now: Date): void {
    this.assertRef(ref);
    if (identities.length < 1 || identities.length > 64) {
      this.quarantine(ref, "lineage_invalid", now);
      return;
    }
    const resolved = identities.map(identity => this.resolve(identity));
    if (resolved.some(value => value === undefined)) {
      this.quarantine(ref, "lineage_unresolved", now);
      return;
    }
    this.authority.db.transaction(() => {
      const insert = this.authority.db.prepare(
        `INSERT OR IGNORE INTO memory_projection_dependencies(
          projection_kind,projection_id,component_id,target_digest,keyed_subject_digest,
          source_identity_digest,content_identity_digest,citation_identity_digest,
          source_context_id,created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const identity of resolved) {
        if (identity === undefined) continue;
        insert.run(ref.kind, ref.id, ref.component_id, identity.target_digest,
          identity.keyed_subject_digest, identity.source_identity_digest,
          identity.content_identity_digest, identity.citation_identity_digest,
          identity.source_context_id, now.toISOString());
      }
      this.activateRef(ref);
    }).immediate();
  }

  inherit(ref: MemoryProjectionRef, parents: readonly MemoryProjectionRef[], now: Date): void {
    this.assertRef(ref);
    if (parents.length < 1 || parents.length > 64 || parents.some(parent => !this.validRef(parent))) {
      this.quarantine(ref, "lineage_invalid", now);
      return;
    }
    const dependencies = parents.flatMap(parent => this.dependencies(parent));
    const parentQuarantined = parents.some(parent => this.isQuarantined(parent));
    if (dependencies.length === 0 || parentQuarantined) {
      this.quarantine(ref, parentQuarantined ? "lineage_ambiguous" : "lineage_unresolved", now);
      return;
    }
    this.bind(ref, dependencies, now);
  }

  hasLineage(ref: MemoryProjectionRef): boolean {
    this.assertRef(ref);
    return this.isQuarantined(ref) || this.authority.db.prepare(
      `SELECT 1 FROM memory_projection_dependencies
       WHERE projection_kind=? AND projection_id=? AND component_id=? LIMIT 1`,
    ).get(ref.kind, ref.id, ref.component_id) !== undefined;
  }

  quarantineUnresolved(ref: MemoryProjectionRef, now: Date): void {
    this.assertRef(ref);
    this.quarantine(ref, "lineage_unresolved", now);
  }

  isQuarantined(ref: MemoryProjectionRef): boolean {
    this.assertRef(ref);
    return this.authority.db.prepare(
      `SELECT 1 FROM memory_projection_quarantine
       WHERE projection_kind=? AND projection_id=? AND component_id=?`,
    ).get(ref.kind, ref.id, ref.component_id) !== undefined;
  }

  quarantineUnresolvedMemory(now: Date): void {
    const at = now.toISOString();
    this.authority.db.prepare(
      `INSERT OR IGNORE INTO memory_projection_quarantine(
        projection_kind,projection_id,component_id,reason_code,detected_at,source_digest
       ) SELECT 'context',m.context_id,m.context_id,'lineage_unresolved',?,NULL
         FROM personal_context_memory_evidence m
         WHERE NOT EXISTS (SELECT 1 FROM memory_projection_dependencies d
           WHERE d.projection_kind='context' AND d.projection_id=m.context_id)
         GROUP BY m.context_id`,
    ).run(at);
    this.authority.db.prepare(
      `INSERT OR IGNORE INTO memory_projection_quarantine(
        projection_kind,projection_id,component_id,reason_code,detected_at,source_digest
       ) SELECT 'recommendation',r.recommendation_id,r.recommendation_id,
         'lineage_unresolved',?,NULL FROM personal_recommendations r
         JOIN memory_projection_quarantine q ON q.projection_kind='context'
           AND q.projection_id=r.context_id`,
    ).run(at);
    this.authority.db.prepare(
      `INSERT OR IGNORE INTO memory_projection_quarantine(
        projection_kind,projection_id,component_id,reason_code,detected_at,source_digest
       ) SELECT 'recommendation_action',a.recommendation_id,CAST(a.rank AS TEXT),
         'lineage_unresolved',?,NULL FROM personal_recommendation_actions a
         JOIN memory_projection_quarantine q ON q.projection_kind='recommendation'
           AND q.projection_id=a.recommendation_id`,
    ).run(at);
  }

  assertReady(): void {
    const row = this.authority.db.prepare(
      "SELECT rebuild_state FROM memory_projection_authority WHERE singleton_id=1",
    ).get() as { readonly rebuild_state: string } | undefined;
    if (row?.rebuild_state !== "ready") throw new JarvisError("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
  }

  initialize(now: Date): void {
    if (!Number.isFinite(now.getTime())) throw new JarvisError("MEMORY_PROJECTION_REBUILD_CLOCK_INVALID");
    this.authority.db.transaction(() => this.rebuild(now)).immediate();
  }

  private rebuild(now: Date): void {
    const state = this.authority.db.prepare(
      "SELECT rebuild_state FROM memory_projection_authority WHERE singleton_id=1",
    ).get() as { readonly rebuild_state: string } | undefined;
    if (state?.rebuild_state === "ready") return;
    if (state === undefined) throw new JarvisError("MEMORY_PROJECTION_AUTHORITY_NOT_READY");
    this.authority.db.prepare(
      `UPDATE memory_projection_authority SET rebuild_state='rebuilding',failure_code=NULL
       WHERE singleton_id=1 AND rebuild_state IN ('pending','failed','rebuilding')`,
    ).run();
    const contexts = this.authority.db.prepare(
      "SELECT context_id,memory_ref FROM personal_context_memory_evidence ORDER BY context_id,memory_ref",
    ).all() as Array<{ readonly context_id: string; readonly memory_ref: string }>;
    for (const row of contexts) {
      const ref = { kind: "context" as const, id: row.context_id, component_id: row.context_id };
      const targets = this.targetsForRef(row.memory_ref);
      const target = targets[0];
      if (targets.length === 1 && target !== undefined) this.bind(ref, [target], now);
      else this.quarantine(ref, targets.length === 0 ? "lineage_unresolved" : "lineage_ambiguous", now);
    }
    this.authority.db.prepare(
      `UPDATE memory_projection_authority SET rebuild_state='ready',rebuilt_at=?,failure_code=NULL
       WHERE singleton_id=1 AND rebuild_state='rebuilding'`,
    ).run(now.toISOString());
  }

  private activateRef(ref: MemoryProjectionRef): void {
    this.authority.db.prepare(
      `INSERT OR IGNORE INTO memory_projection_suppressions(
        sequence,projection_kind,projection_id,component_id,suppression_id,effective_at
       ) SELECT s.sequence,?,?,?,s.suppression_id,s.effective_at
         FROM memory_suppressions s JOIN memory_projection_dependencies d ON
           d.projection_kind=? AND d.projection_id=? AND d.component_id=? AND (
             d.target_digest=s.target_digest
             OR d.source_identity_digest=s.source_identity_digest
             OR d.content_identity_digest=s.content_identity_digest
             OR d.citation_identity_digest=s.citation_identity_digest)
         WHERE s.state='active'`,
    ).run(ref.kind, ref.id, ref.component_id, ref.kind, ref.id, ref.component_id);
  }

  private dependencies(ref: MemoryProjectionRef): readonly MemoryProjectionDependency[] {
    const rows = this.authority.db.prepare(
      `SELECT target_digest,keyed_subject_digest,source_identity_digest,content_identity_digest,
              citation_identity_digest,source_context_id
       FROM memory_projection_dependencies
       WHERE projection_kind=? AND projection_id=? AND component_id=? ORDER BY target_digest`,
    ).all(ref.kind, ref.id, ref.component_id) as DependencyRow[];
    return rows.map(row => ({ target_digest: row.target_digest,
      keyed_subject_digest: row.keyed_subject_digest ?? undefined,
      source_identity_digest: row.source_identity_digest ?? undefined,
      content_identity_digest: row.content_identity_digest ?? undefined,
      citation_identity_digest: row.citation_identity_digest ?? undefined,
      source_context_id: row.source_context_id ?? undefined }));
  }

  private resolve(identity: MemoryProjectionDependency): DependencyRow | undefined {
    if (identity.target_digest !== undefined) return {
      target_digest: identity.target_digest,
      keyed_subject_digest: identity.keyed_subject_digest ?? null,
      source_identity_digest: identity.source_identity_digest ?? null,
      content_identity_digest: identity.content_identity_digest ?? null,
      citation_identity_digest: identity.citation_identity_digest ?? null,
      source_context_id: identity.source_context_id ?? null,
    };
    const targets = this.targetsForIdentity(identity);
    const target = targets.length === 1 ? targets[0] : undefined;
    return target === undefined ? undefined : { ...target,
      source_context_id: identity.source_context_id ?? null };
  }

  private targetsForRef(memoryRef: string): readonly TargetRow[] {
    return this.authority.db.prepare(
      `SELECT target_digest,keyed_subject_digest,source_identity_digest,
              content_identity_digest,citation_identity_digest
       FROM memory_resolved_target_metadata WHERE target_id=? OR target_digest=?`,
    ).all(memoryRef, memoryRef) as TargetRow[];
  }

  private targetsForIdentity(identity: MemoryProjectionDependency): readonly TargetRow[] {
    return this.authority.db.prepare(
      `SELECT target_digest,keyed_subject_digest,source_identity_digest,
              content_identity_digest,citation_identity_digest
       FROM memory_resolved_target_metadata WHERE
         (? IS NOT NULL AND source_identity_digest=?)
         OR (? IS NOT NULL AND content_identity_digest=?)
         OR (? IS NOT NULL AND citation_identity_digest=?)`,
    ).all(identity.source_identity_digest ?? null, identity.source_identity_digest ?? null,
      identity.content_identity_digest ?? null, identity.content_identity_digest ?? null,
      identity.citation_identity_digest ?? null, identity.citation_identity_digest ?? null) as TargetRow[];
  }

  private quarantine(ref: MemoryProjectionRef, reason: string, now: Date): void {
    this.authority.db.prepare(
      `INSERT OR IGNORE INTO memory_projection_quarantine(
        projection_kind,projection_id,component_id,reason_code,detected_at,source_digest
       ) VALUES(?,?,?,?,?,NULL)`,
    ).run(ref.kind, ref.id, ref.component_id, reason, now.toISOString());
  }

  private assertRef(ref: MemoryProjectionRef): void {
    if (!this.validRef(ref)) throw new JarvisError("MEMORY_PROJECTION_REF_INVALID");
  }

  private validRef(ref: MemoryProjectionRef): boolean {
    return MEMORY_PROJECTION_KINDS.includes(ref.kind)
      && ref.id.length > 0 && ref.component_id.length > 0;
  }
}
