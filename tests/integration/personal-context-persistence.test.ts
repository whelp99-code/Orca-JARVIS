import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthorityDb, canonicalPersonalContractHash, parseContextSnapshotV1, parseObservationEnvelopeV1, parseRecommendationV1, type Sha256Digest } from "../../src/index.js";
import { tempDb } from "../helpers.js";

const NOW = "2026-08-28T10:00:00.000Z";
const LATER = "2026-08-28T10:30:00.000Z";
const EXPIRES = "2026-08-28T12:00:00.000Z";
const UUIDS = ["018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7001", "018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7002", "018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7003", "018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7004", "018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7005"] as const;
function digest(character: string): Sha256Digest { const value = `sha256:${character.repeat(64)}`; function valid(candidate: string): candidate is Sha256Digest { return /^sha256:[0-9a-f]{64}$/.test(candidate); } if (!valid(value)) throw new TypeError("digest fixture"); return value; }
const source = (provider: "orca" | "second-brain" | "jarvis") => ({ source_id: `src:pos:v1:${provider}:primary`, source_kind: provider === "second-brain" ? "second_brain" : provider === "jarvis" ? "authority" : "live_adapter", host_id: provider === "second-brain" ? "host:pos:linux-second-brain" : "host:pos:linux-control-plane", source_version: "v1", evidence_ref: `ref:${provider}:bounded` });
const base = (id: string, provider: "orca" | "second-brain" | "jarvis", payload: Readonly<Record<string, unknown>>, evidence: readonly Readonly<Record<string, unknown>>[] = [], overrides: Readonly<Record<string, unknown>> = {}) => ({ schema_version: 1, id, created_at: NOW, observed_at: "2026-08-28T09:59:00.000Z", valid_at: "2026-08-28T09:59:00.000Z", source: source(provider), authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null }, freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T11:00:00.000Z" }, expires_at: EXPIRES, idempotency_key: `idem:pos:v1:test:${createHash("sha256").update(id).digest("hex")}`, correlation_id: `corr:pos:v1:${UUIDS[3]}`, causation_id: null, payload, policy_decision: { decision: "allow", policy_version: "policy-v1", reason_codes: ["POLICY_SATISFIED"] }, evidence, receipt: null, ...overrides });
const observation = (provider: "orca" | "second-brain", uuid: string, checkpoint: string, content = digest(provider === "orca" ? "a" : "b"), overrides: Readonly<Record<string, unknown>> = {}) => base(`obs:pos:v1:${source(provider).source_id}:${uuid}`, provider, { kind: "status", subject: `subject:${provider}`, value: { state: "ready", excerpt: "bounded" }, trust: "verified", sensitivity: "personal", cursor: `cursor:${checkpoint}`, checkpoint, content_digest: content, state: "fresh" }, [], overrides);
const evidence = (uuid: string, sourceId: string, value: string) => ({ evidence_id: `evi:pos:v1:${uuid}`, digest: value, kind: "bounded_ref", source_id: sourceId, observed_at: "2026-08-28T09:59:00.000Z" });
function isDatabaseRecord(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function databaseRecord(value: unknown): Readonly<Record<string, unknown>> { if (!isDatabaseRecord(value)) throw new TypeError("database row fixture"); return value; }

async function database(): Promise<AuthorityDb> { const db = new AuthorityDb(tempDb()); await db.migrate(); return db; }
function context(observations: readonly ReturnType<typeof parseObservationEnvelopeV1>[], overrides: Readonly<Record<string, unknown>> = {}) {
  return base(`ctx:pos:v1:${UUIDS[2]}`, "jarvis", { purpose: "daily_prioritization", query: "What should happen next?", included_observation_refs: observations.map(item => item.id), included_memory_refs: [], excluded_refs: [], pending_authority_refs: [], conflicts: ["sources disagree"], omissions: ["calendar unavailable"], budgets: { max_items: 16, max_excerpt_bytes: 1024, max_total_bytes: 8192 }, state: "sufficient" }, observations.map((item, index) => evidence(UUIDS[index] ?? UUIDS[0], item.source.source_id, canonicalPersonalContractHash(item))), overrides);
}
function recommendation(contextValue: ReturnType<typeof parseContextSnapshotV1>, overrides: Readonly<Record<string, unknown>> = {}) {
  return base(`rec:pos:v1:${UUIDS[3]}`, "jarvis", { context_id: contextValue.id, context_digest: canonicalPersonalContractHash(contextValue), actions: [{ rank: 1, title: "Review the next bounded step", operation: "review", target_digest: digest("e") }], citations: contextValue.evidence.map(item => item.evidence_id), conflicts: contextValue.payload.conflicts, omissions: contextValue.payload.omissions, confidence_basis: "verified mixed sources", state: "eligible" }, contextValue.evidence, overrides);
}

describe("personal context persistence", () => {
  it("reconstructs a mixed-source observation, context, recommendation, evidence, and action flow", async () => {
    // Given two bounded observations from distinct sources
    const db = await database(); const live = parseObservationEnvelopeV1(observation("orca", UUIDS[0], "checkpoint-1")); const memory = parseObservationEnvelopeV1(observation("second-brain", UUIDS[1], "checkpoint-1"));
    try {
      // When the public AuthorityDb seam persists the complete advisory flow
      expect(db.persistObservation(live, NOW)).toMatchObject({ inserted: true, checkpoint_sequence: 1 });
      expect(db.persistObservation(memory, NOW)).toMatchObject({ inserted: true, checkpoint_sequence: 1 });
      const snapshot = parseContextSnapshotV1(context([live, memory])); const storedContext = db.persistContextSnapshot(snapshot, NOW);
      const advised = parseRecommendationV1(recommendation(snapshot)); const storedRecommendation = db.persistRecommendation({ recommendation: advised, approval_requirement: "owner", confidence_class: "high" }, NOW);
      db.transitionRecommendationAction({ recommendation_id: advised.id, rank: 1, state: "accepted", evidence_digest: storedRecommendation.evidence_digest, occurred_at: LATER });
      const reconstructed = db.getPersonalRecommendation(advised.id);
      // Then bounded immutable records and append-only state evidence are returned
      expect(storedContext).toMatchObject({ version: 1, observation_count: 2 });
      expect(reconstructed).toMatchObject({ recommendation: { recommendation_id: advised.id, approval_requirement: "owner", confidence_class: "high" }, evidence: [{ evidence_id: snapshot.evidence[0]?.evidence_id }, { evidence_id: snapshot.evidence[1]?.evidence_id }], actions: [{ rank: 1, state: "accepted" }] });
      expect(reconstructed?.action_events.map(event => event.state)).toEqual(["pending", "accepted"]);
      expect(db.db.pragma("quick_check", { simple: true })).toBe("ok"); expect(db.db.pragma("foreign_key_check")).toEqual([]);
    } finally { db.close(); }
  });

  it("makes identical observation identity idempotent and rejects a changed digest", async () => {
    // Given one persisted canonical observation
    const db = await database(); const value = observation("orca", UUIDS[0], "checkpoint-1");
    try {
      // When it is replayed identically or with changed content
      expect(db.persistObservation(value, NOW)).toMatchObject({ inserted: true });
      expect(db.persistObservation(value, NOW)).toMatchObject({ inserted: false });
      expect(() => db.persistObservation(observation("orca", UUIDS[0], "checkpoint-1", digest("c")), NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_OBSERVATION_IDENTITY_CONFLICT" }));
      // Then one immutable row remains
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM personal_observations").get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  it("rejects future observations and stale or conflicting checkpoints", async () => {
    // Given a source with one accepted checkpoint
    const db = await database();
    try {
      db.persistObservation(observation("orca", UUIDS[0], "checkpoint-2"), NOW);
      // When future, stale, and conflicting checkpoint envelopes arrive
      const future = observation("orca", UUIDS[1], "checkpoint-3", digest("b"), { created_at: LATER, observed_at: LATER, valid_at: LATER, freshness: { state: "fresh", checked_at: LATER, fresh_until: "2026-08-28T11:30:00.000Z" } });
      expect(() => db.persistObservation(future, NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_OBSERVATION_FUTURE" }));
      expect(() => db.persistObservation(observation("orca", UUIDS[1], "checkpoint-1", digest("b"), { observed_at: "2026-08-28T09:58:00.000Z", valid_at: "2026-08-28T09:58:00.000Z" }), NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_CHECKPOINT_STALE" }));
      expect(() => db.persistObservation(observation("orca", UUIDS[1], "checkpoint-2"), NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_CHECKPOINT_REPLAY_CONFLICT" }));
    } finally { db.close(); }
  });

  it("rejects expired evidence, expired decisions, changed evidence, and illegal action transitions", async () => {
    // Given a valid observation, context, and recommendation
    const db = await database(); const live = parseObservationEnvelopeV1(observation("orca", UUIDS[0], "checkpoint-1"));
    try {
      db.persistObservation(live, NOW);
      const expiringSource = parseObservationEnvelopeV1(observation("second-brain", UUIDS[1], "checkpoint-1", digest("b"), { expires_at: "2026-08-28T10:15:00.000Z", freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T10:10:00.000Z" } }));
      db.persistObservation(expiringSource, NOW);
      expect(() => db.persistContextSnapshot(parseContextSnapshotV1(context([expiringSource])), LATER)).toThrowError(expect.objectContaining({ code: "PERSONAL_CONTEXT_SOURCE_EXPIRED" }));
      const expiredContext = parseContextSnapshotV1(context([live], { expires_at: "2026-08-28T10:15:00.000Z", freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T10:10:00.000Z" } }));
      expect(() => db.persistContextSnapshot(expiredContext, LATER)).toThrowError(expect.objectContaining({ code: "PERSONAL_CONTEXT_EXPIRED" }));
      const snapshot = parseContextSnapshotV1(context([live])); db.persistContextSnapshot(snapshot, NOW);
      const advised = parseRecommendationV1(recommendation(snapshot, { expires_at: "2026-08-28T10:15:00.000Z", freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T10:10:00.000Z" } }));
      const stored = db.persistRecommendation({ recommendation: advised, approval_requirement: "owner", confidence_class: "high" }, NOW);
      expect(() => db.transitionRecommendationAction({ recommendation_id: advised.id, rank: 1, state: "accepted", evidence_digest: digest("f"), occurred_at: "2026-08-28T10:05:00.000Z" })).toThrowError(expect.objectContaining({ code: "PERSONAL_RECOMMENDATION_EVIDENCE_CONFLICT" }));
      expect(() => db.transitionRecommendationAction({ recommendation_id: advised.id, rank: 1, state: "accepted", evidence_digest: stored.evidence_digest, occurred_at: LATER })).toThrowError(expect.objectContaining({ code: "PERSONAL_RECOMMENDATION_EXPIRED" }));
      const fresh = parseRecommendationV1(recommendation(snapshot, { id: `rec:pos:v1:${UUIDS[4]}` })); const active = db.persistRecommendation({ recommendation: fresh, approval_requirement: "owner", confidence_class: "high" }, NOW);
      db.transitionRecommendationAction({ recommendation_id: fresh.id, rank: 1, state: "rejected", evidence_digest: active.evidence_digest, occurred_at: "2026-08-28T10:05:00.000Z" });
      expect(() => db.transitionRecommendationAction({ recommendation_id: fresh.id, rank: 1, state: "accepted", evidence_digest: active.evidence_digest, occurred_at: "2026-08-28T10:06:00.000Z" })).toThrowError(expect.objectContaining({ code: "PERSONAL_ACTION_STATE_CONFLICT" }));
    } finally { db.close(); }
  });

  it("publishes immutable query indexes without sensitive or raw columns", async () => {
    // Given the fully migrated Task 7 schema
    const db = await database();
    try {
      // When its machine-consumed schema inventory is inspected
      const tables = ["personal_observations", "personal_source_checkpoints", "personal_context_snapshots", "personal_context_observations", "personal_recommendations", "personal_recommendation_evidence", "personal_recommendation_actions", "personal_recommendation_action_events", "personal_context_audit_events"];
      const columns = tables.flatMap(table => db.db.prepare(`PRAGMA table_info(${table})`).all().map(column => databaseRecord(column)["name"]));
      const indexes = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'personal_%'").all().map(row => databaseRecord(row)["name"]);
      // Then expiry, source/checkpoint, context, lifecycle, evidence, and audit paths exist
      expect(indexes).toEqual(expect.arrayContaining(["personal_observations_source_checkpoint", "personal_observations_expiry", "personal_source_checkpoints_latest", "personal_context_expiry", "personal_recommendations_lifecycle", "personal_recommendation_evidence_ref", "personal_action_events_history", "personal_context_audit_subject"]));
      expect(columns.filter(column => typeof column === "string" && /secret|token|password|private|raw|body|terminal_output|mcp_page/i.test(column))).toEqual([]);
      expect(() => db.db.prepare("INSERT INTO personal_context_audit_events(event_type,subject_id,subject_digest,correlation_id,causation_id,occurred_at) VALUES(?,?,?,?,?,?)").run("invalid", "subject", digest("a"), "correlation", null, NOW)).toThrow(/constraint/i);
    } finally { db.close(); }
  });

  it("maps parser size failures to stable persistence codes", async () => {
    // Given oversized observation and context boundary inputs
    const db = await database(); const oversized = observation("orca", UUIDS[0], "checkpoint-1");
    try {
      const payload = oversized.payload; if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new TypeError("payload fixture");
      const observationInput = { ...oversized, payload: { ...payload, value: "x".repeat(4097) } };
      // When each crosses the AuthorityDb boundary
      expect(() => db.persistObservation(observationInput, NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_OBSERVATION_INVALID" }));
      const contextInput = context([], { payload: { purpose: "daily", query: "query", included_observation_refs: [], included_memory_refs: Array.from({ length: 33 }, (_, index) => `memory:${index}`), excluded_refs: [], pending_authority_refs: [], conflicts: [], omissions: [], budgets: { max_items: 32, max_excerpt_bytes: 1024, max_total_bytes: 8192 }, state: "sufficient" } });
      expect(() => db.persistContextSnapshot(contextInput, NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_CONTEXT_OVERSIZE" }));
    } finally { db.close(); }
  });
});
