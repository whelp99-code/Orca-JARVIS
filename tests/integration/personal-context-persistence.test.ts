import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthorityDb, canonicalPersonalContractHash, parseContextSnapshotV1, parseObservationEnvelopeV1, parseRecommendationV1, type ContextMemoryEvidenceBinding, type Sha256Digest } from "../../src/index.js";
import { tempDb } from "../helpers.js";

const NOW = "2026-08-28T10:00:00.000Z";
const LATER = "2026-08-28T10:30:00.000Z";
const EXPIRES = "2026-08-28T12:00:00.000Z";
const UUIDS = ["018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7001", "018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7002", "018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7003", "018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7004", "018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7005", "018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7006", "018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7007", "018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7008"] as const;
function digest(character: string): Sha256Digest { const value = `sha256:${character.repeat(64)}`; function valid(candidate: string): candidate is Sha256Digest { return /^sha256:[0-9a-f]{64}$/.test(candidate); } if (!valid(value)) throw new TypeError("digest fixture"); return value; }
const source = (provider: "orca" | "second-brain" | "jarvis") => ({ source_id: `src:pos:v1:${provider}:primary`, source_kind: provider === "second-brain" ? "second_brain" : provider === "jarvis" ? "authority" : "live_adapter", host_id: provider === "second-brain" ? "host:pos:linux-second-brain" : "host:pos:linux-control-plane", source_version: "v1", evidence_ref: `ref:${provider}:bounded` });
const base = (id: string, provider: "orca" | "second-brain" | "jarvis", payload: Readonly<Record<string, unknown>>, evidence: readonly Readonly<Record<string, unknown>>[] = [], overrides: Readonly<Record<string, unknown>> = {}) => ({ schema_version: 1, id, created_at: NOW, observed_at: "2026-08-28T09:59:00.000Z", valid_at: "2026-08-28T09:59:00.000Z", source: source(provider), authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null }, freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T11:00:00.000Z" }, expires_at: EXPIRES, idempotency_key: `idem:pos:v1:test:${createHash("sha256").update(id).digest("hex")}`, correlation_id: `corr:pos:v1:${UUIDS[3]}`, causation_id: null, payload, policy_decision: { decision: "allow", policy_version: "policy-v1", reason_codes: ["POLICY_SATISFIED"] }, evidence, receipt: null, ...overrides });
const observation = (provider: "orca" | "second-brain", uuid: string, checkpoint: string, content = digest(provider === "orca" ? "a" : "b"), overrides: Readonly<Record<string, unknown>> = {}) => base(`obs:pos:v1:${source(provider).source_id}:${uuid}`, provider, { kind: "status", subject: `subject:${provider}`, value: { state: "ready", excerpt: "bounded" }, trust: "verified", sensitivity: "personal", cursor: `cursor:${checkpoint}`, checkpoint, content_digest: content, state: "fresh" }, [], overrides);
const evidence = (uuid: string, sourceId: string, value: string) => ({ evidence_id: `evi:pos:v1:${uuid}`, digest: value, kind: "bounded_ref", source_id: sourceId, observed_at: "2026-08-28T09:59:00.000Z" });
function isDatabaseRecord(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function databaseRecord(value: unknown): Readonly<Record<string, unknown>> { if (!isDatabaseRecord(value)) throw new TypeError("database row fixture"); return value; }

async function database(): Promise<AuthorityDb> { const db = new AuthorityDb(tempDb()); await db.migrate(); return db; }
function persistContext(db: AuthorityDb, value: unknown, now = NOW, memory_evidence: readonly ContextMemoryEvidenceBinding[] = []) { return db.persistContextSnapshot({ context: value, memory_evidence }, now); }
function context(observations: readonly ReturnType<typeof parseObservationEnvelopeV1>[], overrides: Readonly<Record<string, unknown>> = {}) {
  return base(`ctx:pos:v1:${UUIDS[2]}`, "jarvis", { purpose: "daily_prioritization", query: "What should happen next?", included_observation_refs: observations.map(item => item.id), included_memory_refs: [], excluded_refs: [], pending_authority_refs: [], conflicts: ["sources disagree"], omissions: ["calendar unavailable"], budgets: { max_items: 16, max_excerpt_bytes: 1024, max_total_bytes: 8192 }, state: "sufficient" }, observations.map((item, index) => evidence(UUIDS[index] ?? UUIDS[0], item.source.source_id, canonicalPersonalContractHash(item))), { expires_at: "2026-08-28T11:00:00.000Z", freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T10:59:59.999Z" }, ...overrides });
}
function recommendation(contextValue: ReturnType<typeof parseContextSnapshotV1>, overrides: Readonly<Record<string, unknown>> = {}) {
  return base(`rec:pos:v1:${UUIDS[3]}`, "jarvis", { context_id: contextValue.id, context_digest: canonicalPersonalContractHash(contextValue), actions: [{ rank: 1, title: "Review the next bounded step", operation: "review", target_digest: digest("e") }], citations: contextValue.evidence.map(item => item.evidence_id), conflicts: contextValue.payload.conflicts, omissions: contextValue.payload.omissions, confidence_basis: "verified mixed sources", state: contextValue.evidence.length === 0 ? "abstained" : "eligible" }, contextValue.evidence, { expires_at: contextValue.expires_at, freshness: contextValue.freshness, ...overrides });
}

describe("personal context persistence", () => {
  it("reconstructs a mixed-source observation, context, recommendation, evidence, and action flow", async () => {
    // Given two bounded observations from distinct sources
    const db = await database(); const live = parseObservationEnvelopeV1(observation("orca", UUIDS[0], "checkpoint-1")); const memory = parseObservationEnvelopeV1(observation("second-brain", UUIDS[1], "checkpoint-1"));
    try {
      // When the public AuthorityDb seam persists the complete advisory flow
      expect(db.persistObservation(live, NOW)).toMatchObject({ inserted: true, checkpoint_sequence: 1 });
      expect(db.persistObservation(memory, NOW)).toMatchObject({ inserted: true, checkpoint_sequence: 1 });
      const snapshot = parseContextSnapshotV1(context([live, memory])); const storedContext = persistContext(db, snapshot);
      const advised = parseRecommendationV1(recommendation(snapshot)); const storedRecommendation = db.persistRecommendation({ recommendation: advised, approval_requirement: "owner", confidence_class: "high" }, NOW);
      db.transitionRecommendationAction({ recommendation_id: advised.id, rank: 1, state: "accepted", evidence_digest: storedRecommendation.evidence_digest, occurred_at: LATER });
      const reconstructed = db.getPersonalRecommendation(advised.id);
      // Then bounded immutable records and append-only state evidence are returned
      expect(storedContext).toMatchObject({ version: 1, observation_count: 2 });
      expect(reconstructed).toMatchObject({ recommendation: { recommendation_id: advised.id, approval_requirement: "owner", confidence_class: "high" }, evidence: [{ evidence_id: snapshot.evidence[0]?.evidence_id }, { evidence_id: snapshot.evidence[1]?.evidence_id }], actions: [{ rank: 1, state: "accepted" }] });
      expect(reconstructed?.action_events.map((event: Readonly<Record<string, unknown>>) => event["state"])).toEqual(["pending", "accepted"]);
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
      expect(() => persistContext(db, parseContextSnapshotV1(context([expiringSource])), LATER)).toThrowError(expect.objectContaining({ code: "PERSONAL_CONTEXT_SOURCE_EXPIRED" }));
      const expiredContext = parseContextSnapshotV1(context([live], { expires_at: "2026-08-28T10:15:00.000Z", freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T10:10:00.000Z" } }));
      expect(() => persistContext(db, expiredContext, LATER)).toThrowError(expect.objectContaining({ code: "PERSONAL_CONTEXT_EXPIRED" }));
      const snapshot = parseContextSnapshotV1(context([live])); persistContext(db, snapshot);
      const advised = parseRecommendationV1(recommendation(snapshot, { expires_at: "2026-08-28T10:15:00.000Z", freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T10:10:00.000Z" } }));
      const stored = db.persistRecommendation({ recommendation: advised, approval_requirement: "owner", confidence_class: "high" }, NOW);
      expect(() => db.transitionRecommendationAction({ recommendation_id: advised.id, rank: 1, state: "accepted", evidence_digest: digest("f"), occurred_at: "2026-08-28T10:05:00.000Z" })).toThrowError(expect.objectContaining({ code: "PERSONAL_RECOMMENDATION_EVIDENCE_CONFLICT" }));
      expect(() => db.transitionRecommendationAction({ recommendation_id: advised.id, rank: 1, state: "accepted", evidence_digest: stored.evidence_digest, occurred_at: LATER })).toThrowError(expect.objectContaining({ code: "PERSONAL_RECOMMENDATION_EXPIRED" }));
      const fresh = parseRecommendationV1(recommendation(snapshot, { id: `rec:pos:v1:${UUIDS[4]}`, idempotency_key: `idem:pos:v1:test:${"c".repeat(64)}` })); const active = db.persistRecommendation({ recommendation: fresh, approval_requirement: "owner", confidence_class: "high" }, NOW);
      db.transitionRecommendationAction({ recommendation_id: fresh.id, rank: 1, state: "rejected", evidence_digest: active.evidence_digest, occurred_at: "2026-08-28T10:05:00.000Z" });
      expect(() => db.transitionRecommendationAction({ recommendation_id: fresh.id, rank: 1, state: "accepted", evidence_digest: active.evidence_digest, occurred_at: "2026-08-28T10:06:00.000Z" })).toThrowError(expect.objectContaining({ code: "PERSONAL_ACTION_STATE_CONFLICT" }));
    } finally { db.close(); }
  });

  it("publishes immutable query indexes without sensitive or raw columns", async () => {
    // Given the fully migrated Task 7 schema
    const db = await database();
    try {
      // When its machine-consumed schema inventory is inspected
      const tables = ["personal_observations", "personal_source_checkpoints", "personal_context_snapshots", "personal_context_observations", "personal_context_evidence", "personal_recommendations", "personal_recommendation_evidence", "personal_recommendation_actions", "personal_recommendation_action_events", "personal_context_audit_events"];
      const columns = tables.flatMap(table => db.db.prepare(`PRAGMA table_info(${table})`).all().map(column => databaseRecord(column)["name"]));
      const indexes = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'personal_%'").all().map(row => databaseRecord(row)["name"]);
      // Then expiry, source/checkpoint, context, lifecycle, evidence, and audit paths exist
      expect(indexes).toEqual(expect.arrayContaining(["personal_observations_source_checkpoint", "personal_observations_expiry", "personal_source_checkpoints_latest", "personal_context_expiry", "personal_context_evidence_ref", "personal_recommendations_lifecycle", "personal_recommendation_evidence_ref", "personal_action_events_history", "personal_context_audit_subject"]));
      expect(columns.filter(column => typeof column === "string" && /secret|token|password|private|raw|body|terminal_output|mcp_page/i.test(column))).toEqual([]);
      expect(() => db.db.prepare("INSERT INTO personal_context_audit_events(event_type,subject_id,subject_digest,correlation_id,causation_id,occurred_at) VALUES(?,?,?,?,?,?)").run("invalid", "subject", digest("a"), "correlation", null, NOW)).toThrow(/constraint/i);
    } finally { db.close(); }
  });

  it("persists generic memory context evidence and binds recommendations to the exact set", async () => {
    const db = await database();
    const memoryEvidence = evidence(UUIDS[0], "src:pos:v1:second-brain:primary", digest("b"));
    const snapshot = parseContextSnapshotV1(context([], {
      evidence: [memoryEvidence],
      payload: {
        purpose: "memory_context",
        query: "Which confirmed principle applies?",
        included_observation_refs: [],
        included_memory_refs: ["sid:principle:1"],
        excluded_refs: [],
        pending_authority_refs: [],
        conflicts: [],
        omissions: [],
        budgets: { max_items: 8, max_excerpt_bytes: 1024, max_total_bytes: 8192 },
        state: "sufficient",
      },
    }));
    const binding = { memory_ref: "sid:principle:1", evidence_id: memoryEvidence.evidence_id, source_id: memoryEvidence.source_id, digest: memoryEvidence.digest, observed_at: memoryEvidence.observed_at, fresh_until: snapshot.expires_at };
    try {
      persistContext(db, snapshot, NOW, [binding]);
      const advised = parseRecommendationV1(recommendation(snapshot));
      expect(db.persistRecommendation({ recommendation: advised, approval_requirement: "owner", confidence_class: "high" }, NOW)).toMatchObject({ recommendation_id: advised.id });
      expect(db.getPersonalRecommendation(advised.id)?.context_evidence).toEqual([expect.objectContaining({ evidence_id: memoryEvidence.evidence_id, digest: memoryEvidence.digest })]);
      const changed = parseRecommendationV1(recommendation(snapshot, { id: `rec:pos:v1:${UUIDS[4]}`, idempotency_key: `idem:pos:v1:test:${"9".repeat(64)}`, evidence: [{ ...memoryEvidence, digest: digest("c") }] }));
      expect(() => db.persistRecommendation({ recommendation: changed, approval_requirement: "owner", confidence_class: "high" }, NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_RECOMMENDATION_EVIDENCE_CONFLICT" }));
    } finally { db.close(); }
  });

  it("binds every frozen evidence identity field and reconstructs immutable memory references", async () => {
    const db = await database();
    const live = parseObservationEnvelopeV1(observation("orca", UUIDS[7], "checkpoint-1"));
    const observationEvidence = evidence(UUIDS[0], live.source.source_id, canonicalPersonalContractHash(live));
    const memoryEvidence = evidence(UUIDS[1], "src:pos:v1:second-brain:primary", digest("b"));
    const snapshot = parseContextSnapshotV1(context([live], {
      evidence: [observationEvidence, memoryEvidence],
      payload: {
        purpose: "complete_identity",
        query: "Which bounded evidence applies?",
        included_observation_refs: [live.id],
        included_memory_refs: ["sid:principle:1"],
        excluded_refs: [],
        pending_authority_refs: [],
        conflicts: [],
        omissions: [],
        budgets: { max_items: 8, max_excerpt_bytes: 1024, max_total_bytes: 8192 },
        state: "sufficient",
      },
    }));
    const binding = {
      memory_ref: "sid:principle:1",
      evidence_id: memoryEvidence.evidence_id,
      source_id: memoryEvidence.source_id,
      digest: memoryEvidence.digest,
      observed_at: memoryEvidence.observed_at,
      fresh_until: snapshot.expires_at,
    };
    try {
      db.persistObservation(live, NOW);
      persistContext(db, snapshot, NOW, [binding]);
      const original = parseRecommendationV1(recommendation(snapshot));
      db.persistRecommendation({ recommendation: original, approval_requirement: "owner", confidence_class: "high" }, NOW);
      const probes = [
        ["kind", { ...memoryEvidence, kind: "forged_kind" }],
        ["observed_at", { ...memoryEvidence, observed_at: "2026-08-28T09:58:00.000Z" }],
        ["source_id", { ...memoryEvidence, source_id: "src:pos:v1:second-brain:secondary" }],
        ["digest", { ...memoryEvidence, digest: digest("c") }],
        ["evidence_id", { ...memoryEvidence, evidence_id: `evi:pos:v1:${UUIDS[6]}` }],
      ] as const;
      const variants = [
        ...probes.map(([name, changed]) => [name, [observationEvidence, changed]] as const),
        ["order", [memoryEvidence, observationEvidence]] as const,
        ["unbound", [observationEvidence]] as const,
        ["evidence_free", []] as const,
      ];
      const accepted: string[] = [];
      for (const [index, [name, changedEvidence]] of variants.entries()) {
        const raw = recommendation(snapshot);
        const payload = databaseRecord(raw.payload);
        const variantUuid = `018f0d4e-7b2a-7cc1-8a2b-${(index + 100).toString(16).padStart(12, "0")}`;
        const changed = parseRecommendationV1(recommendation(snapshot, {
          id: `rec:pos:v1:${variantUuid}`,
          idempotency_key: `idem:pos:v1:test:${String(index + 1).repeat(64)}`,
          evidence: changedEvidence,
          payload: { ...payload, citations: changedEvidence.map(item => item.evidence_id) },
        }));
        try {
          db.persistRecommendation({ recommendation: changed, approval_requirement: "owner", confidence_class: "high" }, NOW);
          accepted.push(name);
        } catch (caught) {
          expect(caught).toEqual(expect.objectContaining({ code: "PERSONAL_RECOMMENDATION_EVIDENCE_CONFLICT" }));
        }
      }
      expect(() => parseRecommendationV1(recommendation(snapshot, {
        evidence: [observationEvidence, observationEvidence],
      }))).toThrowError(expect.objectContaining({ code: "PERSONAL_CONTRACT_INVALID" }));
      const reconstructed = db.getPersonalRecommendation(original.id);
      expect({ accepted, memory_evidence: reconstructed?.memory_evidence }).toEqual({
        accepted: [],
        memory_evidence: [{
          memory_ref: "sid:principle:1",
          evidence_id: memoryEvidence.evidence_id,
          source_id: memoryEvidence.source_id,
          digest: memoryEvidence.digest,
          kind: memoryEvidence.kind,
          observed_at: memoryEvidence.observed_at,
          fresh_until: snapshot.expires_at,
        }],
      });
    } finally { db.close(); }
  });

  it("couples recommendation and action expiry to the governing context", async () => {
    const db = await database();
    const snapshot = parseContextSnapshotV1(context([], { expires_at: "2026-08-28T10:15:00.000Z", freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T10:10:00.000Z" } }));
    try {
      persistContext(db, snapshot);
      const outliving = parseRecommendationV1(recommendation(snapshot, { expires_at: EXPIRES, freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T11:00:00.000Z" } }));
      expect(() => db.persistRecommendation({ recommendation: outliving, approval_requirement: "owner", confidence_class: "high" }, NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_RECOMMENDATION_CONTEXT_EXPIRY_CONFLICT" }));
      const bounded = parseRecommendationV1(recommendation(snapshot, { id: `rec:pos:v1:${UUIDS[4]}`, expires_at: snapshot.expires_at, freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T10:10:00.000Z" } }));
      const stored = db.persistRecommendation({ recommendation: bounded, approval_requirement: "owner", confidence_class: "high" }, NOW);
      expect(() => db.transitionRecommendationAction({ recommendation_id: bounded.id, rank: 1, state: "accepted", evidence_digest: stored.evidence_digest, occurred_at: snapshot.expires_at })).toThrowError(expect.objectContaining({ code: "PERSONAL_RECOMMENDATION_EXPIRED" }));
    } finally { db.close(); }
  });

  it("rejects authority-bearing advisory observation, context, and recommendation envelopes", async () => {
    const db = await database();
    const authority = { authority_kind: "control_receipt", principal_id: "owner", request_id: "request:forged", receipt_id: "receipt:forged" };
    try {
      expect(() => db.persistObservation(observation("orca", UUIDS[0], "checkpoint-1", digest("a"), { authority }), NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_OBSERVATION_INVALID" }));
      expect(() => persistContext(db, context([], { authority }))).toThrowError(expect.objectContaining({ code: "PERSONAL_CONTEXT_INVALID" }));
      const snapshot = parseContextSnapshotV1(context([])); persistContext(db, snapshot);
      expect(() => db.persistRecommendation({ recommendation: recommendation(snapshot, { authority }), approval_requirement: "owner", confidence_class: "high" }, NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_RECOMMENDATION_INVALID" }));
    } finally { db.close(); }
  });

  it("binds each family idempotency key and complete recommendation wrapper", async () => {
    const db = await database();
    const shared = `idem:pos:v1:test:${"f".repeat(64)}`;
    try {
      const firstObservation = observation("orca", UUIDS[0], "checkpoint-1", digest("a"), { idempotency_key: shared });
      expect(db.persistObservation(firstObservation, NOW)).toMatchObject({ inserted: true });
      expect(() => db.persistObservation(observation("orca", UUIDS[1], "checkpoint-2", digest("b"), { idempotency_key: shared }), NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_OBSERVATION_IDEMPOTENCY_CONFLICT" }));
      const firstContext = parseContextSnapshotV1(context([], { idempotency_key: shared }));
      expect(persistContext(db, firstContext)).toMatchObject({ observation_count: 0 });
      expect(() => persistContext(db, context([], { id: `ctx:pos:v1:${UUIDS[5]}`, idempotency_key: shared }))).toThrowError(expect.objectContaining({ code: "PERSONAL_CONTEXT_IDEMPOTENCY_CONFLICT" }));
      const advised = parseRecommendationV1(recommendation(firstContext));
      const input = { recommendation: advised, approval_requirement: "owner", confidence_class: "high" } as const;
      expect(db.persistRecommendation(input, NOW)).toEqual(db.persistRecommendation(input, NOW));
      expect(() => db.persistRecommendation({ ...input, confidence_class: "low" }, NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_RECOMMENDATION_IDEMPOTENCY_CONFLICT" }));
    } finally { db.close(); }
  });

  it("rejects newly persisted observations expiring exactly at the injected clock", async () => {
    const db = await database();
    const expired = observation("orca", UUIDS[0], "checkpoint-1", digest("a"), {
      created_at: "2026-08-28T09:30:00.000Z",
      observed_at: "2026-08-28T09:29:00.000Z",
      valid_at: "2026-08-28T09:29:00.000Z",
      freshness: { state: "fresh", checked_at: "2026-08-28T09:30:00.000Z", fresh_until: "2026-08-28T09:59:00.000Z" },
      expires_at: NOW,
    });
    try { expect(() => db.persistObservation(expired, NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_OBSERVATION_EXPIRED" })); }
    finally { db.close(); }
  });

  it("enforces action chronology and exact governing deadline semantics", async () => {
    const db = await database();
    const snapshot = parseContextSnapshotV1(context([], { expires_at: "2026-08-28T10:15:00.000Z", freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T10:10:00.000Z" } }));
    try {
      persistContext(db, snapshot);
      const advised = parseRecommendationV1(recommendation(snapshot, { expires_at: snapshot.expires_at, freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T10:10:00.000Z" } }));
      const stored = db.persistRecommendation({ recommendation: advised, approval_requirement: "owner", confidence_class: "high" }, NOW);
      expect(() => db.transitionRecommendationAction({ recommendation_id: advised.id, rank: 1, state: "accepted", evidence_digest: stored.evidence_digest, occurred_at: "2026-08-28T09:30:00.000Z" })).toThrowError(expect.objectContaining({ code: "PERSONAL_ACTION_STATE_CONFLICT" }));
      expect(() => db.transitionRecommendationAction({ recommendation_id: advised.id, rank: 1, state: "expired", evidence_digest: stored.evidence_digest, occurred_at: "2026-08-28T10:14:59.999Z" })).toThrowError(expect.objectContaining({ code: "PERSONAL_ACTION_STATE_CONFLICT" }));
      expect(() => db.transitionRecommendationAction({ recommendation_id: advised.id, rank: 1, state: "expired", evidence_digest: stored.evidence_digest, occurred_at: snapshot.expires_at })).not.toThrow();
      const second = parseRecommendationV1(recommendation(snapshot, { id: `rec:pos:v1:${UUIDS[4]}`, idempotency_key: `idem:pos:v1:test:${"e".repeat(64)}`, expires_at: snapshot.expires_at, freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T10:10:00.000Z" } }));
      const secondStored = db.persistRecommendation({ recommendation: second, approval_requirement: "owner", confidence_class: "high" }, NOW);
      expect(() => db.transitionRecommendationAction({ recommendation_id: second.id, rank: 1, state: "accepted", evidence_digest: secondStored.evidence_digest, occurred_at: snapshot.expires_at })).toThrowError(expect.objectContaining({ code: "PERSONAL_RECOMMENDATION_EXPIRED" }));
    } finally { db.close(); }
  });

  it("returns linked observation counts on zero and multiple-observation context replay", async () => {
    const db = await database();
    const live = parseObservationEnvelopeV1(observation("orca", UUIDS[0], "checkpoint-1"));
    const memory = parseObservationEnvelopeV1(observation("second-brain", UUIDS[1], "checkpoint-1"));
    try {
      const zero = parseContextSnapshotV1(context([], { payload: { purpose: "zero", query: "zero", included_observation_refs: [], included_memory_refs: [], excluded_refs: [], pending_authority_refs: [], conflicts: ["conflict"], omissions: ["omission"], budgets: { max_items: 8, max_excerpt_bytes: 1024, max_total_bytes: 8192 }, state: "sufficient" } }));
      expect(persistContext(db, zero).observation_count).toBe(0);
      expect(persistContext(db, zero).observation_count).toBe(0);
      db.persistObservation(live, NOW); db.persistObservation(memory, NOW);
      const multiple = parseContextSnapshotV1(context([live, memory], { id: `ctx:pos:v1:${UUIDS[5]}`, idempotency_key: `idem:pos:v1:test:${"d".repeat(64)}` }));
      expect(persistContext(db, multiple).observation_count).toBe(2);
      expect(persistContext(db, multiple).observation_count).toBe(2);
    } finally { db.close(); }
  });

  it("enforces frozen freshness while retaining degraded insufficient history", async () => {
    const db = await database();
    try {
      const staleSufficient = context([], {
        freshness: { state: "stale", checked_at: NOW, fresh_until: "2026-08-28T09:59:00.000Z" },
      });
      expect(() => db.persistContextSnapshot({ context: staleSufficient, memory_evidence: [] }, NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_CONTEXT_FRESHNESS_CONFLICT" }));
      const degraded = context([], {
        id: `ctx:pos:v1:${UUIDS[6]}`,
        idempotency_key: `idem:pos:v1:test:${"9".repeat(64)}`,
        freshness: { state: "unavailable", checked_at: NOW, fresh_until: "2026-08-28T10:01:00.000Z" },
        payload: { purpose: "history", query: "history", included_observation_refs: [], included_memory_refs: [], excluded_refs: [], pending_authority_refs: [], conflicts: [], omissions: ["source unavailable"], budgets: { max_items: 8, max_excerpt_bytes: 1024, max_total_bytes: 8192 }, state: "insufficient" },
      });
      expect(db.persistContextSnapshot({ context: degraded, memory_evidence: [] }, NOW)).toMatchObject({ observation_count: 0 });
      const live = parseObservationEnvelopeV1(observation("orca", UUIDS[0], "checkpoint-1"));
      db.persistObservation(live, NOW);
      const fresh = parseContextSnapshotV1(context([live]));
      persistContext(db, fresh);
      const advised = parseRecommendationV1(recommendation(fresh));
      expect(() => db.persistRecommendation({ recommendation: advised, approval_requirement: "owner", confidence_class: "high" }, fresh.freshness.fresh_until)).toThrowError(expect.objectContaining({ code: "PERSONAL_RECOMMENDATION_STALE" }));
    } finally { db.close(); }
  });

  it("requires one exact fresh memory evidence identity per included memory reference", async () => {
    const db = await database();
    const memoryEvidence = evidence(UUIDS[0], "src:pos:v1:second-brain:primary", digest("b"));
    const snapshot = context([], {
      evidence: [memoryEvidence],
      expires_at: "2026-08-28T10:30:00.000Z",
      freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T10:15:00.000Z" },
      payload: { purpose: "memory", query: "memory", included_observation_refs: [], included_memory_refs: ["sid:one"], excluded_refs: [], pending_authority_refs: [], conflicts: [], omissions: [], budgets: { max_items: 8, max_excerpt_bytes: 1024, max_total_bytes: 8192 }, state: "sufficient" },
    });
    const binding = { memory_ref: "sid:one", evidence_id: memoryEvidence.evidence_id, source_id: memoryEvidence.source_id, digest: memoryEvidence.digest, observed_at: memoryEvidence.observed_at, fresh_until: "2026-08-28T10:30:00.000Z" };
    try {
      expect(() => db.persistContextSnapshot({ context: snapshot, memory_evidence: [] }, NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_CONTEXT_MEMORY_EVIDENCE_CONFLICT" }));
      expect(db.persistContextSnapshot({ context: snapshot, memory_evidence: [binding] }, NOW)).toMatchObject({ evidence_count: 1 });
      const equalDeadline = { ...snapshot, id: `ctx:pos:v1:${UUIDS[7]}`, idempotency_key: `idem:pos:v1:test:${"8".repeat(64)}` };
      expect(() => db.persistContextSnapshot({ context: equalDeadline, memory_evidence: [{ ...binding, fresh_until: NOW }] }, NOW)).toThrowError(expect.objectContaining({ code: "PERSONAL_CONTEXT_EVIDENCE_STALE" }));
    } finally { db.close(); }
  });

  it("resolves exact family replay before temporal admission and preserves changed conflicts", async () => {
    const db = await database();
    const value = observation("orca", UUIDS[0], "checkpoint-1", digest("a"), { expires_at: "2026-08-28T10:15:00.000Z", freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T10:10:00.000Z" } });
    try {
      expect(db.persistObservation(value, NOW)).toMatchObject({ inserted: true });
      expect(db.persistObservation(value, "2026-08-28T10:15:00.000Z")).toMatchObject({ inserted: false });
      expect(() => db.persistObservation({ ...value, payload: { ...databaseRecord(value.payload), content_digest: digest("c") } }, "2026-08-28T10:15:00.000Z")).toThrowError(expect.objectContaining({ code: "PERSONAL_OBSERVATION_IDENTITY_CONFLICT" }));
      const live = parseObservationEnvelopeV1(value);
      const snapshot = parseContextSnapshotV1(context([live], { expires_at: "2026-08-28T10:10:00.000Z", freshness: { state: "fresh", checked_at: NOW, fresh_until: "2026-08-28T10:09:00.000Z" } }));
      const storedContext = persistContext(db, snapshot);
      expect(persistContext(db, snapshot, snapshot.expires_at)).toEqual(storedContext);
      expect(() => persistContext(db, { ...snapshot, payload: { ...snapshot.payload, query: "changed" } }, snapshot.expires_at)).toThrowError(expect.objectContaining({ code: "PERSONAL_CONTEXT_IDEMPOTENCY_CONFLICT" }));
      const advised = parseRecommendationV1(recommendation(snapshot));
      const input = { recommendation: advised, approval_requirement: "owner", confidence_class: "high" } as const;
      const storedRecommendation = db.persistRecommendation(input, NOW);
      expect(db.persistRecommendation(input, advised.expires_at)).toEqual(storedRecommendation);
      expect(() => db.persistRecommendation({ ...input, confidence_class: "low" }, advised.expires_at)).toThrowError(expect.objectContaining({ code: "PERSONAL_RECOMMENDATION_IDEMPOTENCY_CONFLICT" }));
    } finally { db.close(); }
  });

  it("supports complete action variants, exact replay, and one SQL terminal event", async () => {
    const db = await database(); const live = parseObservationEnvelopeV1(observation("orca", UUIDS[0], "checkpoint-1"));
    try {
      db.persistObservation(live, NOW);
      const snapshot = parseContextSnapshotV1(context([live])); persistContext(db, snapshot);
      const advised = parseRecommendationV1(recommendation(snapshot)); const stored = db.persistRecommendation({ recommendation: advised, approval_requirement: "owner", confidence_class: "high" }, NOW);
      const dismissed = { recommendation_id: advised.id, rank: 1, state: "dismissed", evidence_digest: stored.evidence_digest, occurred_at: "2026-08-28T10:05:00.000Z" } as const;
      expect(() => db.transitionRecommendationAction(dismissed)).not.toThrow();
      expect(() => db.transitionRecommendationAction(dismissed)).not.toThrow();
      expect(() => db.db.prepare("INSERT INTO personal_recommendation_action_events(recommendation_id,rank,state,evidence_digest,occurred_at) VALUES(?,?,?,?,?)").run(advised.id, 1, "snoozed", stored.evidence_digest, "2026-08-28T10:06:00.000Z")).toThrow(/terminal/i);
      const second = parseRecommendationV1(recommendation(snapshot, { id: `rec:pos:v1:${UUIDS[4]}`, idempotency_key: `idem:pos:v1:test:${"7".repeat(64)}` }));
      const secondStored = db.persistRecommendation({ recommendation: second, approval_requirement: "owner", confidence_class: "high" }, NOW);
      expect(() => db.transitionRecommendationAction({ recommendation_id: second.id, rank: 1, state: "snoozed", evidence_digest: secondStored.evidence_digest, occurred_at: "2026-08-28T10:06:00.000Z" })).not.toThrow();
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
      expect(() => persistContext(db, contextInput)).toThrowError(expect.objectContaining({ code: "PERSONAL_CONTEXT_OVERSIZE" }));
    } finally { db.close(); }
  });
});
