import type Database from "better-sqlite3";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import type {
  MemoryProjectionDependency,
  MemoryProjectionRef,
} from "./memory-projection-types.js";

type TargetRow = {
  readonly target_digest: string;
  readonly keyed_subject_digest: string;
  readonly source_identity_digest: string;
  readonly content_identity_digest: string;
  readonly citation_identity_digest: string;
};

type RecommendationActionLineage = {
  readonly rank: number;
  readonly target_digest: string;
};

export function bindContextMemoryProjection(
  database: Database.Database,
  contextId: string,
  memoryRefs: readonly string[],
  now: Date,
): void {
  if (!projectionAuthorityReady(database) || memoryRefs.length === 0) return;
  const authority = new MemoryProjectionAuthority({ db: database });
  const ref = contextRef(contextId);
  const targets = memoryRefs.flatMap(memoryRef => targetsForRef(database, memoryRef));
  if (targets.length !== memoryRefs.length) {
    const active = database.prepare(
      "SELECT 1 FROM memory_tombstone_chain LIMIT 1",
    ).get();
    if (active !== undefined) authority.quarantineUnresolved(ref, now);
    return;
  }
  authority.bind(ref, targets.map(target => dependency(target, contextId)), now);
}

export function bindRecommendationProjection(
  database: Database.Database,
  recommendationId: string,
  contextId: string,
  actions: readonly RecommendationActionLineage[],
  now: Date,
): void {
  if (!projectionAuthorityReady(database)) return;
  const authority = new MemoryProjectionAuthority({ db: database });
  const parent = contextRef(contextId);
  const recommendation = recommendationRef(recommendationId);
  if (authority.hasLineage(parent)) authority.inherit(recommendation, [parent], now);
  for (const action of actions) {
    const ref = { kind: "recommendation_action" as const, id: recommendationId,
      component_id: String(action.rank) };
    const target = targetsForRef(database, action.target_digest);
    const exactTarget = target[0];
    if (target.length === 1 && exactTarget !== undefined) {
      authority.bind(ref, [dependency(exactTarget, contextId)], now);
    } else if (target.length > 1) authority.quarantineUnresolved(ref, now);
    else if (authority.hasLineage(recommendation)) authority.inherit(ref, [recommendation], now);
  }
}

export function bindNotificationProjection(
  database: Database.Database,
  intentId: string,
  recommendationIds: readonly string[],
  contextIds: readonly string[],
  now: Date,
): void {
  if (!projectionAuthorityReady(database)) return;
  const authority = new MemoryProjectionAuthority({ db: database });
  const parents = [
    ...recommendationIds.map(recommendationRef),
    ...contextIds.map(contextRef),
  ];
  if (parents.some(parent => authority.hasLineage(parent))) authority.inherit({
    kind: "notification_intent", id: intentId, component_id: intentId,
  }, parents, now);
}

export function bindNotificationDeliveryProjection(
  database: Database.Database,
  deliveryId: string,
  intentId: string,
  now: Date,
): void {
  if (!projectionAuthorityReady(database)) return;
  const authority = new MemoryProjectionAuthority({ db: database });
  const parent = { kind: "notification_intent" as const, id: intentId, component_id: intentId };
  if (authority.hasLineage(parent)) authority.inherit({
    kind: "notification_delivery", id: deliveryId, component_id: deliveryId,
  }, [parent], now);
}

export function bindDailyLoopProjection(
  database: Database.Database,
  runId: string,
  stepId: string | null,
  value: unknown,
  now: Date,
): void {
  if (!projectionAuthorityReady(database)) return;
  const run = { kind: "daily_run" as const, id: runId, component_id: runId };
  bindStructuredProjection(database, run, value, now);
  if (stepId === null) return;
  const step = { kind: "daily_step" as const, id: stepId, component_id: stepId };
  bindStructuredProjection(database, step, value, now);
  const authority = new MemoryProjectionAuthority({ db: database });
  if (authority.hasLineage(run) && !authority.hasLineage(step)) authority.inherit(step, [run], now);
}

export function bindStructuredProjection(
  database: Database.Database,
  ref: MemoryProjectionRef,
  value: unknown,
  now: Date,
): void {
  if (!projectionAuthorityReady(database)) return;
  const collected = collectStructuredLineage(value);
  if (!collected.complete) {
    new MemoryProjectionAuthority({ db: database }).quarantineUnresolved(ref, now);
    return;
  }
  if (collected.memoryRefs.length > 0) {
    const targets = collected.memoryRefs.flatMap(memoryRef => targetsForRef(database, memoryRef));
    const authority = new MemoryProjectionAuthority({ db: database });
    if (targets.length !== collected.memoryRefs.length) authority.quarantineUnresolved(ref, now);
    else authority.bind(ref, targets.map(target => dependency(target, null)), now);
    return;
  }
  const authority = new MemoryProjectionAuthority({ db: database });
  const parents = collected.parents;
  if (parents.some(parent => authority.hasLineage(parent))) authority.inherit(ref, parents, now);
}

function collectStructuredLineage(value: unknown): {
  readonly complete: boolean;
  readonly memoryRefs: readonly string[];
  readonly parents: readonly MemoryProjectionRef[];
} {
  const memoryRefs = new Set<string>();
  const parents = new Map<string, MemoryProjectionRef>();
  let complete = true;
  let remaining = 4096;
  const visit = (candidate: unknown, depth: number): void => {
    if (!complete || candidate === null || typeof candidate !== "object") return;
    if (depth > 8) { complete = false; return; }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (--remaining < 0) { complete = false; return; }
        visit(item, depth + 1);
        if (!complete) return;
      }
      return;
    }
    for (const key of Reflect.ownKeys(candidate)) {
      if (--remaining < 0) { complete = false; return; }
      if (typeof key !== "string") continue;
      const item = Reflect.get(candidate, key);
      if (typeof item === "string") collectKey(key, item, memoryRefs, parents);
      else visit(item, depth + 1);
      if (!complete) return;
    }
  };
  visit(value, 0);
  return { complete, memoryRefs: [...memoryRefs].sort(),
    parents: [...parents.values()].sort((left, right) => left.id.localeCompare(right.id)) };
}

function collectKey(
  key: string,
  value: string,
  memoryRefs: Set<string>,
  parents: Map<string, MemoryProjectionRef>,
): void {
  switch (key) {
    case "memory_ref": case "target_digest":
      memoryRefs.add(value);
      return;
    case "context_id": {
      const ref = contextRef(value); parents.set(`${ref.kind}:${ref.id}`, ref); return;
    }
    case "recommendation_id": {
      const ref = recommendationRef(value); parents.set(`${ref.kind}:${ref.id}`, ref); return;
    }
    case "intent_id": {
      const ref = { kind: "notification_intent" as const, id: value, component_id: value };
      parents.set(`${ref.kind}:${ref.id}`, ref); return;
    }
    case "run_id": {
      const ref = { kind: "daily_run" as const, id: value, component_id: value };
      parents.set(`${ref.kind}:${ref.id}`, ref); return;
    }
    default:
      return;
  }
}

function projectionAuthorityReady(database: Database.Database): boolean {
  const installed = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_projection_authority'",
  ).get() !== undefined;
  if (installed) new MemoryProjectionAuthority({ db: database }).assertReady();
  return installed;
}

function targetsForRef(database: Database.Database, memoryRef: string): readonly TargetRow[] {
  return database.prepare(
    `SELECT target_digest,keyed_subject_digest,source_identity_digest,
            content_identity_digest,citation_identity_digest
     FROM memory_resolved_target_metadata WHERE target_id=? OR target_digest=?`,
  ).all(memoryRef, memoryRef) as TargetRow[];
}

function dependency(target: TargetRow, contextId: string | null): MemoryProjectionDependency {
  return { target_digest: target.target_digest,
    keyed_subject_digest: target.keyed_subject_digest,
    source_identity_digest: target.source_identity_digest,
    content_identity_digest: target.content_identity_digest,
    citation_identity_digest: target.citation_identity_digest,
    ...(contextId === null ? {} : { source_context_id: contextId }) };
}

function contextRef(id: string): MemoryProjectionRef {
  return { kind: "context", id, component_id: id };
}

function recommendationRef(id: string): MemoryProjectionRef {
  return { kind: "recommendation", id, component_id: id };
}
