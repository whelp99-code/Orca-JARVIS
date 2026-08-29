import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";
import {
  PERSONAL_CONNECTOR_REGISTRY_SESSION,
  PersonalConnectorConfigError,
  PersonalConnectorError,
  createPersonalConnectorRegistry,
} from "../../src/index.js";
import { CONNECTOR_NOW, connectorHarness, connectorRequest } from "../fixtures/personal-connector-sources.js";

const digest = (value: number): string => `sha256:${value.toString(16).padStart(64, "0")}`;

describe("Task 13 scoped registry sessions", () => {
  it("root 1 rejects prototype, own-read, subclass-shaped, and proxy factory forgery", async () => {
    const base = await connectorHarness();
    const ownRead = { ...base.factory_input, read: async () => ({}) };
    const inherited = Object.create(base.factory_input);
    const proxied = new Proxy(base.factory_input, { getPrototypeOf: () => { throw new Error("attacker"); } });
    try {
      for (const hostile of [ownRead, inherited, proxied]) {
        expect(() => createPersonalConnectorRegistry(hostile)).toThrow(new PersonalConnectorConfigError());
      }
      expect(() => Reflect.construct(publicApi.PersonalConnectorRegistry, [Symbol("forged"), base.factory_input]))
        .toThrow(new PersonalConnectorConfigError());
    } finally { base.db.close(); }
  });

  it("root 2 projects exact requested fields and empty scopes do not invoke Orca", async () => {
    const calls = { count: 0 };
    const { db, registry } = await connectorHarness({ orca_calls: calls });
    try {
      const connected = await registry.inspect({
        connector_id: "orca", scopes: ["orca.connectivity.read"], fields: ["connected"],
      });
      expect(connected.values).toEqual({ connected: true });
      const empty = await registry.inspect({ connector_id: "orca", scopes: [], fields: [] });
      expect(empty).toMatchObject({ state: "no_data", reason: "no_scope", values: {} });
      expect(calls.count).toBe(1);
    } finally { db.close(); }
  });

  it.each([
    [{ kind: "search" as const, query: "fixture" }, "second_brain.search.read", ["sb_search", "sb_read_page"]],
    [{ kind: "page" as const, page_id: "wiki/principle" }, "second_brain.page.read", ["sb_read_page"]],
    [{ kind: "recent" as const, days: 7 }, "second_brain.recent.read", ["sb_recent_changes", "sb_read_page"]],
    [{ kind: "conflicts" as const }, "second_brain.conflict.read", ["sb_open_conflicts", "sb_read_page"]],
  ])("root 2 maps configured Second Brain operation %s to exact scope and Task11 dispatch", async (operation, scope, expected) => {
    const memory_calls: { methods: ("sb_search" | "sb_read_page" | "sb_recent_changes" | "sb_open_conflicts")[] } = { methods: [] };
    const { db, registry } = await connectorHarness({ operation, memory_calls });
    try {
      const listed = registry.list().find(item => item.id === "second_brain");
      expect(listed?.scopes).toEqual([scope]);
      await registry.inspect({ connector_id: "second_brain", scopes: [scope], fields: [] });
      expect(memory_calls.methods).toEqual(expected);
    } finally { db.close(); }
  });

  it("root 2 rejects a field owned by an unrequested scope without invoking Orca", async () => {
    const calls = { count: 0 };
    const { db, registry } = await connectorHarness({ orca_calls: calls });
    try {
      await expect(registry.inspect({
        connector_id: "orca", scopes: ["orca.identity.read"], fields: ["connected"],
      })).rejects.toMatchObject({ code: "PERSONAL_CONNECTOR_REQUEST_INVALID" });
      expect(calls.count).toBe(0);
    } finally { db.close(); }
  });

  it("root 3 uses signed report time and later receipt cannot advance identity", async () => {
    const first = await connectorHarness({
      portfolio_reported_at: "2026-08-20T00:00:00.000Z", portfolio_received_at: CONNECTOR_NOW,
    });
    try {
      const result = await first.registry.inspect(connectorRequest("portfolio"));
      expect(result).toMatchObject({ state: "offline", reason: "source_offline", freshness: "unknown", values: {} });
    } finally { first.db.close(); }
  });

  it("root 3 does not let later receipt advance authenticated portfolio identity", async () => {
    const reportedAt = new Date(CONNECTOR_NOW.getTime() - 60_000).toISOString();
    const early = await connectorHarness({
      portfolio_reported_at: reportedAt,
      portfolio_received_at: new Date(CONNECTOR_NOW.getTime() - 30_000),
    });
    const late = await connectorHarness({ portfolio_reported_at: reportedAt, portfolio_received_at: CONNECTOR_NOW });
    try {
      const first = await early.registry.inspect(connectorRequest("portfolio"));
      const second = await late.registry.inspect(connectorRequest("portfolio"));
      expect([second.observed_at, second.cursor, second.values.reported_at]).toEqual([
        first.observed_at, first.cursor, first.values.reported_at,
      ]);
    } finally { early.db.close(); late.db.close(); }
  });

  it("root 4 keeps one-millisecond Task11 no_data fresh", async () => {
    let clockCalls = 0;
    const outcome = {
      kind: "no_data", checked_at: CONNECTOR_NOW.toISOString(),
      fresh_until: new Date(CONNECTOR_NOW.getTime() + 60_000).toISOString(),
    } as const;
    const { db, registry } = await connectorHarness({
      outcome,
      clock: () => { clockCalls += 1; return new Date(CONNECTOR_NOW.getTime() + (clockCalls === 1 ? 1 : 0)); },
    });
    try {
      expect(await registry.inspect(connectorRequest("second_brain"))).toMatchObject({
        state: "no_data", reason: "current_empty", freshness: "fresh", values: {},
      });
    } finally { db.close(); }
  });

  it.each([[60_000, "no_data", "current_empty"], [60_001, "unavailable", "source_stale"]])(
    "root 4 enforces bounded no_data freshness at offset %i",
    async (offset, state, reason) => {
      let clockCalls = 0;
      const outcome = {
        kind: "no_data", checked_at: CONNECTOR_NOW.toISOString(),
        fresh_until: new Date(CONNECTOR_NOW.getTime() + 60_000).toISOString(),
      } as const;
      const harness = await connectorHarness({
        outcome, max_age_ms: 30_000, expiry_ms: 60_000,
        clock: () => { clockCalls += 1; return new Date(CONNECTOR_NOW.getTime() + (clockCalls === 1 ? offset : 0)); },
      });
      try {
        const result = await harness.registry.inspect(connectorRequest("second_brain"));
        expect(result).toMatchObject({ state, reason, values: {}, evidence_refs: [] });
      } finally { harness.db.close(); }
    },
  );

  it("root 4 clears values and evidence references for final non-readable states", async () => {
    for (const outcome of [
      { kind: "no_data", checked_at: CONNECTOR_NOW.toISOString(), fresh_until: CONNECTOR_NOW.toISOString() } as const,
      { kind: "offline", checked_at: CONNECTOR_NOW.toISOString(), code: "SECOND_BRAIN_OFFLINE" } as const,
      { kind: "unavailable", checked_at: CONNECTOR_NOW.toISOString(), code: "SECOND_BRAIN_UNAVAILABLE" } as const,
    ]) {
      const harness = await connectorHarness({ outcome });
      try {
        const result = await harness.registry.inspect(connectorRequest("second_brain"));
        expect(result.values).toEqual({});
        expect(result.evidence_refs).toEqual([]);
      } finally { harness.db.close(); }
    }
  });

  it("root 4 treats historical timeline metadata as a current query and projects decision IDs", async () => {
    const base = await connectorHarness();
    base.db.db.prepare(`INSERT INTO control_command_requests(
      request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,
      expires_at,nonce,state,lease_fence,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "request:old", "git.push", 4, JSON.stringify({ task_id: "task:old" }), "{}", digest(9), 1, "fixture",
      "2020-01-01T00:00:00.000Z", "2026-08-30T00:00:00.000Z", "nonce:old", "pending", 0,
      "2020-01-01T00:00:00.000Z",
    );
    const registry = createPersonalConnectorRegistry(base.factory_input);
    try {
      const result = await registry.inspect(connectorRequest("task_timeline"));
      expect(result).toMatchObject({ state: "ready", reason: "current", freshness: "unknown" });
      expect(result.values).toHaveProperty("decision_id");
      expect(result.values.observed_at).toBe("2020-01-01T00:00:00.000Z");
    } finally { base.db.close(); }
  });

  it("root 5 bounds one active handle per connector across 2,000 advances", async () => {
    let now = CONNECTOR_NOW;
    const overrides: Record<string, unknown> = {};
    const harness = await connectorHarness({ clock: () => now, orca_overrides: overrides });
    try {
      let result = await harness.registry.inspect(connectorRequest("orca"));
      for (let index = 1; index <= 2_000; index += 1) {
        if (result.checkpoint === null) throw new TypeError("checkpoint missing");
        overrides["handle"] = `terminal-${index + 1}`;
        now = new Date(CONNECTOR_NOW.getTime() + index);
        result = await harness.registry.inspect(connectorRequest("orca", result.checkpoint));
      }
      expect(result.checkpoint).toMatch(/^pcp:1:[0-9a-f-]{36}:[0-9a-f-]{36}$/u);
      expect(Reflect.get(harness.registry, "sources")).toBeUndefined();
      expect(Reflect.get(harness.registry, "checkpoints")).toBeUndefined();
      expect(PERSONAL_CONNECTOR_REGISTRY_SESSION).toEqual({
        version: 1, persistence: "process_local", restart: "handles_invalid", max_total: 4, max_per_connector: 1,
      });
    } finally { harness.db.close(); }
  });

  it("root 5 admits exactly four configured connector identities", async () => {
    const harness = await connectorHarness();
    try {
      const checkpoints: (string | null)[] = [];
      for (const id of ["second_brain", "orca", "task_timeline", "portfolio"] as const) {
        checkpoints.push((await harness.registry.inspect(connectorRequest(id))).checkpoint);
      }
      expect(checkpoints).toHaveLength(PERSONAL_CONNECTOR_REGISTRY_SESSION.max_total);
      expect(checkpoints.every(checkpoint => checkpoint !== null)).toBe(true);
    } finally { harness.db.close(); }
  });

  it("root 5 permits one concurrent progression winner and retires its predecessor", async () => {
    let now = CONNECTOR_NOW;
    const overrides: Record<string, unknown> = {};
    const harness = await connectorHarness({ clock: () => now, orca_overrides: overrides });
    try {
      const first = await harness.registry.inspect(connectorRequest("orca"));
      if (first.checkpoint === null) throw new TypeError("checkpoint missing");
      overrides["handle"] = "terminal-2";
      now = new Date(CONNECTOR_NOW.getTime() + 1);
      const attempts = await Promise.all([
        harness.registry.inspect(connectorRequest("orca", first.checkpoint)),
        harness.registry.inspect(connectorRequest("orca", first.checkpoint)),
      ]);
      expect(attempts.map(result => result.reason).sort()).toEqual(["checkpoint_invalid", "current"]);
      expect((await harness.registry.inspect(connectorRequest("orca", first.checkpoint))).reason).toBe("checkpoint_invalid");
    } finally { harness.db.close(); }
  });

  it("root 5 returns a typed session-invalid result after registry restart", async () => {
    const first = await connectorHarness();
    const result = await first.registry.inspect(connectorRequest("orca"));
    first.db.close();
    if (result.checkpoint === null) throw new TypeError("checkpoint missing");
    const restarted = await connectorHarness();
    try {
      expect(await restarted.registry.inspect(connectorRequest("orca", result.checkpoint))).toMatchObject({
        state: "unavailable", reason: "checkpoint_session_invalid",
      });
    } finally { restarted.db.close(); }
  });

  it("root 6 rejects hostile options and copies retained Buffer aliases", async () => {
    const hostile = Object.defineProperty({}, "clock", { enumerable: true, get: () => { throw new Error("attacker"); } });
    expect(() => createPersonalConnectorRegistry(hostile)).toThrow(new PersonalConnectorConfigError());
    const harness = await connectorHarness();
    harness.factory_input.portfolio.envelope.fill(0);
    harness.factory_input.portfolio.key.fill(0);
    try {
      expect(await harness.registry.inspect(connectorRequest("portfolio"))).toMatchObject({ state: "ready", reason: "current" });
    } finally { harness.db.close(); }
  });

  it("root 7 removes forgeable wrapper constructors from the public package", () => {
    for (const name of [
      "SecondBrainPersonalConnectorSource", "OrcaPersonalConnectorSource",
      "TaskTimelinePersonalConnectorSource", "PortfolioPersonalConnectorSource",
    ]) expect(name in publicApi).toBe(false);
    expect(PersonalConnectorError).toBeTypeOf("function");
  });
});
