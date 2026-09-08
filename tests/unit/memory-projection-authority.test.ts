import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Jarvis from "../../src/index.js";
import { AuthorityDb } from "../../src/db.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import { tempDb } from "../helpers.js";

const correction = ((JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  readonly vectors: { readonly correction: { readonly request: MemoryEffectWriteRequestV2 } };
}).vectors.correction.request);
const target = correction.targets[0];
const delta = correction.tombstone_chain_delta[0];
if (target === undefined || delta === undefined) throw new Error("MEMORY_FIXTURE_INVALID");

type ProjectionRef = {
  readonly kind: string;
  readonly id: string;
  readonly component_id: string;
};
type ProjectionAuthority = {
  bind(ref: ProjectionRef, identities: readonly Readonly<Record<string, string | undefined>>[], now: Date): void;
  inherit(ref: ProjectionRef, parents: readonly ProjectionRef[], now: Date): void;
  isSuppressed(ref: ProjectionRef): boolean;
  visible<T>(rows: readonly T[], ref: (row: T) => ProjectionRef): readonly T[];
  assertReady(): void;
};
type ProjectionAuthorityConstructor = new (authority: AuthorityDb) => ProjectionAuthority;

function isProjectionAuthorityConstructor(value: unknown): value is ProjectionAuthorityConstructor {
  return typeof value === "function";
}

const refs = [
  { kind: "context", id: "context:1", component_id: "context:1" },
  { kind: "recommendation", id: "recommendation:1", component_id: "recommendation:1" },
  { kind: "recommendation_action", id: "recommendation:1", component_id: "1" },
  { kind: "daily_run", id: "daily:1", component_id: "daily:1" },
  { kind: "morning_brief", id: "brief:1", component_id: "brief:1" },
  { kind: "evening_closeout", id: "closeout:1", component_id: "closeout:1" },
  { kind: "notification_intent", id: "notification:1", component_id: "notification:1" },
  { kind: "task_timeline", id: "timeline:1", component_id: "timeline:1" },
  { kind: "dashboard_projection", id: "dashboard:1", component_id: "today" },
  { kind: "control_payload", id: "api:1", component_id: "personal-api" },
  { kind: "state_generation", id: "state:1", component_id: "state:1" },
] as const;

describe("normalized memory projection authority", () => {
  it("preserves dependencies from every resolved parent", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const projections = new Jarvis.MemoryProjectionAuthority(db);
      const at = new Date(correction.created_at);
      const second = { kind: "context", id: "context:second", component_id: "context:second" } as const;
      const secondDigest = `sha256:${"9".repeat(64)}`;
      projections.bind(refs[0], [{ target_digest: target.target_digest }], at);
      projections.bind(second, [{ target_digest: secondDigest }], at);
      projections.inherit(refs[5], [refs[0], second], at);
      expect(projections.isSuppressed(refs[5])).toBe(false);
      expect(db.db.prepare("SELECT target_digest FROM memory_projection_dependencies WHERE projection_id=? ORDER BY target_digest")
        .all(refs[5].id)).toEqual([target.target_digest, secondDigest].sort().map(target_digest => ({ target_digest })));
    } finally { db.close(); }
  });

  it.each([false, true])("quarantines mixed known and missing parents, missing first=%s", async (missingFirst) => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const projections = new Jarvis.MemoryProjectionAuthority(db);
      const at = new Date(correction.created_at);
      const known = refs[0];
      const missing = { kind: "context", id: "missing-parent", component_id: "missing-parent" } as const;
      const child = refs[5];
      projections.bind(known, [{ target_digest: target.target_digest }], at);
      projections.inherit(child, missingFirst ? [missing, known] : [known, missing], at);
      expect(projections.isSuppressed(child)).toBe(true);
      expect(projections.visible([child], ref => ref)).toEqual([]);
      expect(db.db.prepare("SELECT reason_code FROM memory_projection_quarantine WHERE projection_id=?")
        .get(child.id)).toEqual({ reason_code: "lineage_unresolved" });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_projection_dependencies WHERE projection_id=?")
        .get(child.id)).toEqual({ count: 0 });
      projections.inherit(refs[8], [child, known], at);
      expect(projections.isSuppressed(refs[8])).toBe(true);
    } finally { db.close(); }
  });

  it("suppresses all eleven transitive read contexts in the tombstone transaction", async () => {
    // Given: exact target lineage inherited through all required JARVIS projection contexts.
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const constructor = Reflect.get(Jarvis, "MemoryProjectionAuthority");
      expect(isProjectionAuthorityConstructor(constructor)).toBe(true);
      if (!isProjectionAuthorityConstructor(constructor)) return;
      const projections = new constructor(db);
      projections.bind(refs[0], [{ target_digest: target.target_digest,
        source_identity_digest: target.source_identity_full,
        content_identity_digest: target.content_identity_full,
        citation_identity_digest: target.citation_identity_full }], new Date(correction.created_at));
      for (const ref of refs.slice(1)) projections.inherit(ref, [refs[0]], new Date(correction.created_at));
      projections.assertReady();
      expect(projections.visible(refs, ref => ref)).toHaveLength(11);

      // When: correction appends the prior-version tombstone and immediate suppression.
      const appended = new Jarvis.MemoryTombstoneChain(db, Buffer.alloc(32, 6)).append({
        operation: "correct", lane_id: correction.lane_id, targets: correction.targets,
        target_manifest_digest: correction.target_manifest_digest,
        scope_digest: correction.scope_digest,
        authority_receipt_digest: delta.authority_receipt_digest,
        payload_digest: correction.delegation.payload_digest,
        effective_at: correction.created_at,
      });

      // Then: no named context remains visible and one durable content-free invalidation exists.
      expect(projections.visible(refs, ref => ref)).toEqual([]);
      expect(refs.every(ref => projections.isSuppressed(ref))).toBe(true);
      expect(appended).toMatchObject({ suppressed_projection_count: 11,
        suppression_event_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
      expect(db.db.prepare(
        "SELECT projection_count,published_at FROM memory_suppression_events WHERE sequence=1",
      ).get()).toEqual({ projection_count: 11, published_at: null });
    } finally { db.close(); }
  });

  it("quarantines unresolved lineage and suppresses a post-tombstone binding immediately", async () => {
    // Given: one unresolved memory-derived projection and an already active target tombstone.
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const constructor = Reflect.get(Jarvis, "MemoryProjectionAuthority");
      expect(isProjectionAuthorityConstructor(constructor)).toBe(true);
      if (!isProjectionAuthorityConstructor(constructor)) return;
      const projections = new constructor(db);
      const unresolved = { kind: "context", id: "context:unresolved",
        component_id: "context:unresolved" } as const;
      projections.inherit(unresolved, [{ kind: "context", id: "missing", component_id: "missing" }],
        new Date(correction.created_at));
      const chain = new Jarvis.MemoryTombstoneChain(db, Buffer.alloc(32, 6));
      chain.append({ operation: "correct", lane_id: correction.lane_id,
        targets: correction.targets, target_manifest_digest: correction.target_manifest_digest,
        scope_digest: correction.scope_digest,
        authority_receipt_digest: delta.authority_receipt_digest,
        payload_digest: correction.delegation.payload_digest, effective_at: correction.created_at });
      const late = { kind: "observation", id: "observation:late",
        component_id: "observation:late" } as const;

      // When: target lineage is bound after the tombstone is already active.
      projections.bind(late, [{ target_digest: target.target_digest }], new Date(correction.created_at));

      // Then: both unresolved and late-bound content fail closed.
      expect(projections.isSuppressed(unresolved)).toBe(true);
      expect(projections.isSuppressed(late)).toBe(true);
      expect(db.db.prepare("SELECT reason_code FROM memory_projection_quarantine WHERE projection_id=?")
        .get(unresolved.id)).toEqual({ reason_code: "lineage_unresolved" });
    } finally { db.close(); }
  });
});
