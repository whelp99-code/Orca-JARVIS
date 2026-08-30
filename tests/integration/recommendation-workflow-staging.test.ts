import { describe, expect, it } from "vitest";
import {
  Recommendations,
  RecommendationWorkflowStager,
  type AuthorityDb,
} from "../../src/index.js";
import { persistTask18Context, RECOMMENDATION_ID, task18Request } from "../fixtures/recommendation-fixture.js";
import { initialized } from "../helpers.js";

const NOW = new Date("2026-08-28T12:10:00.000Z");

function request(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    schema_version: 1,
    recommendation_id: RECOMMENDATION_ID,
    action_rank: 1,
    requested_by: { principal_id: "test-operator", authenticated_session_id: "session:owner" },
    target: { repository: "Orca-JARVIS", environment: "local" },
    workflow: { goal: "Implement the bounded recommended action", args: { branch: "task25" } },
    budget: { max_steps: 6, max_attempts_per_node: 2 },
    deadline: "2026-08-28T12:45:00.000Z",
    ...overrides,
  };
}

function seed(db: AuthorityDb): ReturnType<Recommendations["create"]> {
  const context = persistTask18Context(db);
  return new Recommendations(db).create(task18Request(context));
}

function count(db: AuthorityDb, table: string): number {
  const row = db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  if (typeof row !== "object" || row === null) throw new TypeError("count row required");
  return Number(Reflect.get(row, "count"));
}

describe("Task 25 recommendation workflow staging", () => {
  it("stages one exact pending workflow request without workflow or external effects", async () => {
    // Given: one fresh owner-required recommendation action and an authenticated owner request.
    const db = await initialized();
    try {
      seed(db);
      const stager = new RecommendationWorkflowStager(db, () => NOW);

      // When: the same accepted action is staged twice.
      const first = stager.stage(request());
      const replay = stager.stage(request());

      // Then: one pending canonical request exists and all execution surfaces remain untouched.
      expect(replay).toEqual(first);
      expect(first).toMatchObject({ action: "workflow.start", action_level: 2, state: "pending", requested_by: "test-operator" });
      expect(first.target).toEqual(expect.objectContaining({ repository: "Orca-JARVIS", environment: "local" }));
      expect(first.args).toEqual(expect.objectContaining({ loop_id: "agentops-default", budget: expect.objectContaining({ deadline: "2026-08-28T12:45:00.000Z" }) }));
      expect(count(db, "control_command_requests")).toBe(1);
      for (const table of ["workflow_runs", "workflow_steps", "loop_definitions", "control_command_redemptions", "control_command_effects", "control_effect_attempts"]) {
        expect(count(db, table), table).toBe(0);
      }
    } finally { db.close(); }
  });

  it("rejects accessor, proxy, private, and wrong-target input with zero writes", async () => {
    // Given: a fresh recommendation and hostile boundary values.
    const db = await initialized();
    try {
      seed(db); const stager = new RecommendationWorkflowStager(db, () => NOW); let accessed = 0;
      const accessor = request(); Object.defineProperty(accessor, "deadline", { enumerable: true, get: () => { accessed += 1; return "2026-08-28T12:45:00.000Z"; } });
      const proxy = new Proxy(request() as object, { getPrototypeOf: () => { throw new TypeError("hostile proxy"); } });
      const cases = [accessor, proxy, request({ workflow: { goal: "bounded", args: { access_token: "private" } } }),
        request({ workflow: { goal: "bad\uD800goal", args: {} } }),
        request({ target: { repository: "Other", environment: "local" } }),
        request({ target: { repository: "Orca-JARVIS", environment: "remote" } })];

      // When/Then: every malformed request fails closed without invoking an accessor or writing a request.
      cases.forEach((value, index) => expect(() => stager.stage(value), `hostile case ${index}`).toThrow());
      expect(accessed).toBe(0);
      expect(count(db, "control_command_requests")).toBe(0);
    } finally { db.close(); }
  });

  it("rejects every noncanonical nested array without traps or writes", async () => {
    // Given: array shapes that could execute code or hide noncanonical values.
    const db = await initialized();
    try {
      seed(db); const stager = new RecommendationWorkflowStager(db, () => NOW); let accesses = 0;
      const accessor: unknown[] = [];
      Object.defineProperty(accessor, "0", { enumerable: true, get: () => { accesses += 1; return "hidden"; } });
      Object.defineProperty(accessor, "length", { value: 1, writable: true, configurable: false });
      const sparse = new Array(1);
      const custom = ["value"]; Object.defineProperty(custom, "extra", { value: true, enumerable: true });
      const nonenumerable = ["value"]; Object.defineProperty(nonenumerable, "hidden", { value: true });
      const frozen = Object.freeze(["value"]);
      const symbol = ["value"]; Object.defineProperty(symbol, Symbol("hidden"), { value: true });
      const inherited = ["value"]; Object.setPrototypeOf(inherited, Object.create(Array.prototype));
      const proxied = new Proxy(["value"], { ownKeys: () => { accesses += 1; return ["0", "length"]; } });
      const cases = [accessor, sparse, custom, nonenumerable, frozen, symbol, inherited, proxied];

      // When/Then: no array is indexed, iterated, or measured before exact closure.
      for (const value of cases) {
        expect(() => stager.stage(request({ workflow: { goal: "bounded", args: { nested: value } } })))
          .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_WORKFLOW_INVALID" }));
      }
      expect(accesses).toBe(0);
      expect(count(db, "control_command_requests")).toBe(0);
    } finally { db.close(); }
  });

  it("maps malformed deadline and clock values to the Task25 contract error", async () => {
    // Given: invalid, overflowing, custom, and proxied time values.
    const decorated = new Date(NOW); Object.defineProperty(decorated, "hidden", { value: true });
    const clocks: Array<() => unknown> = [
      () => null,
      () => Number.NaN,
      () => "2026-08-28T12:10:00.000Z",
      () => Number.MAX_VALUE,
      () => new Date(Number.NaN),
      () => new (class CustomDate extends Date {})(NOW.getTime()),
      () => new Proxy(NOW, {}),
      () => decorated,
    ];
    for (const clock of clocks) {
      const db = await initialized();
      try {
        seed(db);
        expect(() => new RecommendationWorkflowStager(db, clock).stage(request()))
          .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_WORKFLOW_INVALID" }));
        expect(count(db, "control_command_requests")).toBe(0);
      } finally { db.close(); }
    }
    const malformed = ["not-time", "+999999-01-01T00:00:00.000Z", "2026-08-28T12:45:00Z", "NaN"];
    for (const deadline of malformed) {
      const db = await initialized();
      try {
        seed(db);
        expect(() => new RecommendationWorkflowStager(db, () => NOW).stage(request({ deadline })))
          .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_WORKFLOW_INVALID" }));
        expect(count(db, "control_command_requests")).toBe(0);
      } finally { db.close(); }
    }
  });

  it("conflicts changed bytes under immutable identity and preserves one request", async () => {
    // Given: one staged immutable recommendation/action/target/args identity.
    const db = await initialized();
    try {
      seed(db); const stager = new RecommendationWorkflowStager(db, () => NOW); stager.stage(request());
      const changes = [request({ budget: { max_steps: 7, max_attempts_per_node: 2 } }),
        request({ deadline: "2026-08-28T12:44:59.999Z" }),
        request({ workflow: { goal: "Changed goal", args: { branch: "task25" } } })];

      // When/Then: changed command bytes conflict under the same derived key with no partial second write.
      for (const value of changes) expect(() => stager.stage(value)).toThrowError(expect.objectContaining({ code: "CONTROL_COMMAND_REPLAY_CONFLICT" }));
      expect(count(db, "control_command_requests")).toBe(1);
    } finally { db.close(); }
  });

  it("uses the exact recommendation freshness boundary and refuses terminal lifecycle", async () => {
    // Given: identical recommendations viewed one millisecond before and at freshness expiry.
    const beforeDb = await initialized(); const boundaryDb = await initialized();
    try {
      seed(beforeDb); seed(boundaryDb);
      const before = new Date("2026-08-28T12:59:59.998Z");
      expect(() => new RecommendationWorkflowStager(beforeDb, () => before).stage(request({ deadline: "2026-08-28T12:59:59.999Z" }))).not.toThrow();
      const boundary = new Date("2026-08-28T12:59:59.999Z");
      expect(() => new RecommendationWorkflowStager(boundaryDb, () => boundary).stage(request({ deadline: "2026-08-28T13:00:00.000Z" })))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_WORKFLOW_NOT_ELIGIBLE" }));
      expect(count(boundaryDb, "control_command_requests")).toBe(0);
    } finally { beforeDb.close(); boundaryDb.close(); }

    const terminalDb = await initialized();
    try {
      const created = seed(terminalDb);
      terminalDb.transitionRecommendationAction({ recommendation_id: created.recommendation.id, rank: 1, state: "rejected",
        evidence_digest: created.evidence_digest, occurred_at: "2026-08-28T12:09:00.000Z" });
      expect(() => new RecommendationWorkflowStager(terminalDb, () => NOW).stage(request()))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_WORKFLOW_NOT_ELIGIBLE" }));
      expect(count(terminalDb, "control_command_requests")).toBe(0);
    } finally { terminalDb.close(); }
  });

  it("rejects a persisted recommendation expiry mutation before staging", async () => {
    // Given: the persisted scalar expiry changed behind its immutable guard while the envelope remains canonical.
    const db = await initialized();
    try {
      seed(db); db.db.exec("DROP TRIGGER personal_recommendations_immutable_update");
      db.db.prepare("UPDATE personal_recommendations SET expires_at=? WHERE recommendation_id=?")
        .run("2026-08-28T12:50:00.000Z", RECOMMENDATION_ID);

      // When/Then: authoritative row/envelope disagreement has exact zero request writes.
      expect(() => new RecommendationWorkflowStager(db, () => NOW).stage(request()))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_WORKFLOW_NOT_ELIGIBLE" }));
      expect(count(db, "control_command_requests")).toBe(0);
    } finally { db.close(); }
  });

  it("detects one-field persisted recommendation and context mutations", async () => {
    // Given: persisted digests changed behind immutable storage guards.
    const recommendationDb = await initialized(); const contextDb = await initialized();
    try {
      seed(recommendationDb); recommendationDb.db.exec("DROP TRIGGER personal_recommendations_immutable_update");
      recommendationDb.db.prepare("UPDATE personal_recommendations SET evidence_digest=? WHERE recommendation_id=?")
        .run(`sha256:${"f".repeat(64)}`, RECOMMENDATION_ID);
      seed(contextDb); contextDb.db.exec("DROP TRIGGER personal_context_evidence_immutable_update; PRAGMA foreign_keys=OFF");
      contextDb.db.prepare("UPDATE personal_context_evidence SET evidence_digest=? WHERE position=0")
        .run(`sha256:${"e".repeat(64)}`);
      contextDb.db.pragma("foreign_keys=ON");

      // When/Then: canonical reload detects each mutation before ControlPlane staging.
      for (const db of [recommendationDb, contextDb]) {
        expect(() => new RecommendationWorkflowStager(db, () => NOW).stage(request()))
          .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_WORKFLOW_NOT_ELIGIBLE" }));
        expect(count(db, "control_command_requests")).toBe(0);
      }
    } finally { recommendationDb.close(); contextDb.close(); }
  });
});
