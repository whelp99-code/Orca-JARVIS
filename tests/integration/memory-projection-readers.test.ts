import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import {
  AuthorityDb,
  ControlPlane,
  DailyLoopStore,
  EveningCloseoutStore,
  MemoryProjectionAuthority,
  MemoryTombstoneChain,
  Recommendations,
  buildCurrentState,
} from "../../src/index.js";
import { sourceHealth } from "../../src/dashboard/personal-lists.js";
import { controlRequestPage, pendingControlSummary } from "../../src/dashboard/control-request-read.js";
import { PersonalCursorCodec } from "../../src/dashboard/personal-cursor.js";
import { PersonalPagination } from "../../src/dashboard/personal-page.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import { PersonalRecommendationReader } from "../../src/personal-recommendation-reader.js";
import { TaskTimeline } from "../../src/task-timeline.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import { trustedCloseoutKey } from "../fixtures/evening-closeout.js";
import {
  persistTask18Context,
  RECOMMENDATION_NOW,
  task18Request,
} from "../fixtures/recommendation-fixture.js";
import { snapshot, tempDb } from "../helpers.js";

const correction = ((JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  readonly vectors: { readonly correction: { readonly request: MemoryEffectWriteRequestV2 } };
}).vectors.correction.request);
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("MEMORY_FIXTURE_INVALID");
  return value;
}
const target = required(correction.targets[0]);
const delta = required(correction.tombstone_chain_delta[0]);

const digest = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, key);
}

function completeStep(db: AuthorityDb, input: {
  readonly phase: "morning" | "evening";
  readonly key: string;
  readonly detail: unknown;
}): { readonly runId: string; readonly stepId: string } {
  const at = new Date("2026-08-28T11:00:00.000Z");
  const loop = new DailyLoopStore(db);
  const runId = loop.prepare({ due: { kind: "due", local_date: "2026-08-28", phase: input.phase,
    scheduled_at: at.toISOString() }, created_at: at,
  deadline_at: new Date("2026-08-28T12:00:00.000Z"), steps: [{ key: input.key, sequence: 1 }] });
  const claim = loop.claim({ run_id: runId, owner_id: `${input.phase}-worker`, at, lease_ms: 600_000 });
  const step = loop.steps(runId)[0];
  if (step === undefined) throw new Error("MEMORY_DAILY_STEP_MISSING");
  loop.completeStep({ claim, step, detail: input.detail, at });
  return { runId, stepId: step.step_id };
}

describe("memory projection source readers", () => {
  it("hides one target through eleven real JARVIS read contexts before any provider frame", async () => {
    // Given: actual persisted observation, context, recommendation, daily, notification, timeline,
    // dashboard, control, and current-state sources all carry one target lineage.
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const canary = `projection-${randomBytes(32).toString("hex")}`;
    try {
      db.db.prepare(
        `INSERT INTO memory_resolved_target_metadata(
          target_id,target_digest,provider_instance_id,generation_id,generation_manifest_digest,
          page_content_digest,source_identity_digest,content_identity_digest,citation_identity_digest,
          keyed_subject_digest,sensitivity,source_owner_class,source_owner_id_digest,resolved_at,
          expires_at,created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(target.target_id, target.target_digest, target.provider_instance_id, target.generation_id,
        target.generation_manifest_digest, target.page_content_digest, target.source_identity_full,
        target.content_identity_full, target.citation_identity_full, target.subject_digest,
        target.sensitivity, target.source_owner_class, target.source_owner_id_digest,
        target.resolved_at, target.expires_at, target.resolved_at);
      const projections = new MemoryProjectionAuthority(db);
      const context = persistTask18Context(db);
      projections.bind({ kind: "context", id: context.id, component_id: context.id },
        [{ target_digest: target.target_digest }], new Date(RECOMMENDATION_NOW));
      const recommendation = new Recommendations(db).create(task18Request(context)).recommendation;

      const briefCore = { generated_at: RECOMMENDATION_NOW, context_readiness: "ready",
        needs_you_first: [{ copy: canary }], waiting: [], fyi: [], target_digest: target.target_digest };
      const morning = completeStep(db, { phase: "morning", key: "morning_reconcile",
        detail: { ...briefCore, brief_id: `brief:${digest(canary).slice(7)}`,
          canonical_digest: digest(canonicalize(briefCore)) } });
      const evening = completeStep(db, { phase: "evening", key: "evening_summary",
        detail: { canary, target_digest: target.target_digest } });
      projections.bind({ kind: "morning_brief", id: morning.stepId, component_id: morning.stepId },
        [{ target_digest: target.target_digest }], new Date(RECOMMENDATION_NOW));
      projections.bind({ kind: "evening_closeout", id: evening.stepId, component_id: evening.stepId },
        [{ target_digest: target.target_digest }], new Date(RECOMMENDATION_NOW));

      const notificationId = `notification:${randomBytes(8).toString("hex")}`;
      db.db.prepare(
        `INSERT INTO notification_intents(
          intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,redacted_preview,
          deep_link,state,expires_at,created_at,updated_at
         ) VALUES(?,?,?,?,?,'browser',?,?,'created',?,?,?)`,
      ).run(notificationId, "correlation", `idem:${notificationId}`, `dedup:${notificationId}`,
        "action", canary, "/memory", "2026-08-28T13:00:00.000Z", RECOMMENDATION_NOW,
        RECOMMENDATION_NOW);
      projections.bind({ kind: "notification_intent", id: notificationId, component_id: notificationId },
        [{ target_digest: target.target_digest }], new Date(RECOMMENDATION_NOW));

      const observationId = `observation:${randomBytes(8).toString("hex")}`;
      db.db.prepare(
        `INSERT INTO personal_observations(
          observation_id,idempotency_key,source_id,checkpoint,canonical_digest,content_digest,
          canonical_envelope_json,observed_at,valid_at,expires_at,created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(observationId, `idem:${observationId}`, canary, "checkpoint:1",
        digest(canary), digest(canary), JSON.stringify({ canary }), RECOMMENDATION_NOW,
        RECOMMENDATION_NOW, "2026-08-28T13:00:00.000Z", RECOMMENDATION_NOW);
      projections.bind({ kind: "observation", id: observationId, component_id: observationId },
        [{ target_digest: target.target_digest }], new Date(RECOMMENDATION_NOW));

      const taskId = `task:${randomBytes(8).toString("hex")}`;
      db.ingest(snapshot("codex", { id: taskId, action: canary, authorization: "both" }));
      projections.bind({ kind: "task_timeline", id: taskId, component_id: taskId },
        [{ target_digest: target.target_digest }], new Date(RECOMMENDATION_NOW));
      const controlId = `control:${randomBytes(8).toString("hex")}`;
      new ControlPlane(db).stage({ schema_version: 1, request_id: controlId, action: "git.push",
        action_level: 4, target: { task_id: taskId }, args: { task_id: taskId, branch: canary },
        reversible: true, requested_by: "principal:owner", requested_at: RECOMMENDATION_NOW,
        expires_at: "2026-08-28T13:00:00.000Z", nonce: `nonce:${controlId}` },
      new Date(RECOMMENDATION_NOW));
      projections.bind({ kind: "control_payload", id: controlId, component_id: controlId },
        [{ target_digest: target.target_digest }], new Date(RECOMMENDATION_NOW));
      expect(controlRequestPage(db, new Date(RECOMMENDATION_NOW), { limit: 20 }).items.map(item => item.request_id)).toContain(controlId);

      // When: the JARVIS authority appends the tombstone; no provider adapter is constructed or called.
      new MemoryTombstoneChain(db, Buffer.alloc(32, 21)).append({ operation: "correct",
        lane_id: correction.lane_id, targets: correction.targets,
        target_manifest_digest: correction.target_manifest_digest,
        scope_digest: correction.scope_digest,
        authority_receipt_digest: delta.authority_receipt_digest,
        payload_digest: correction.delegation.payload_digest,
        effective_at: correction.created_at });
      expect(controlRequestPage(db, new Date(RECOMMENDATION_NOW), { limit: 20 }).items).toEqual([]);
      expect(pendingControlSummary(db, new Date(RECOMMENDATION_NOW))).toEqual({ total: 0, items: [] });

      const pagination = new PersonalPagination(new PersonalCursorCodec({ key: Buffer.alloc(32, 7),
        sessionId: "memory-projection-readers", keyEpoch: 1 }));
      const health = await sourceHealth(db, { limit: 20, cursor: null,
        now: new Date(RECOMMENDATION_NOW), pagination }, undefined);
      const today = todayProjection(db, new Date(RECOMMENDATION_NOW));
      expect(field(today, "freshness")).toEqual({ state: "no_data", checked_at: null, fresh_until: null });
      const timeline = new TaskTimeline(db);
      const state = await buildCurrentState(db, new Date(RECOMMENDATION_NOW));
      let eveningCloseoutError: string | null = null;
      try {
        new EveningCloseoutStore(db, trustedCloseoutKey).read(evening.runId);
      } catch (error) {
        eveningCloseoutError = error instanceof Error ? error.message : "UNKNOWN";
      }

      // Then: all eleven actual read contexts fail closed and none returns the runtime canary.
      expect({
        observation_visible: health.items.some(item => JSON.stringify(item).includes(canary)),
        context_state: field(today, "state"),
        recommendation_visible: new PersonalRecommendationReader(db.db).get(recommendation.id) !== undefined,
        recommendation_action_count: new Recommendations(db).project(RECOMMENDATION_NOW, 20).lifecycle_actions.length,
        daily_step_count: new DailyLoopStore(db).steps(morning.runId).length,
        morning_brief: field(field(today, "brief"), "state"),
        evening_closeout_error: eveningCloseoutError,
        notification_canary: JSON.stringify(today).includes(notificationId),
        timeline_visible: timeline.list(100).some(item => item.task_id === taskId),
        control_visible: new ControlPlane(db).list().some(item => item.request_id === controlId),
        state_canary: JSON.stringify(state).includes(canary),
      }).toEqual({ observation_visible: false, context_state: "no_data",
        recommendation_visible: false, recommendation_action_count: 0, daily_step_count: 0,
        morning_brief: "no_data", evening_closeout_error: "EVENING_CLOSEOUT_NOT_FOUND",
        notification_canary: false, timeline_visible: false, control_visible: false,
        state_canary: false });
    } finally {
      db.close();
    }
  });
});
