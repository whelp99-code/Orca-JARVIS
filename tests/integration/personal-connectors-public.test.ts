import { describe, expect, it } from "vitest";
import {
  PersonalConnectorConfigError,
  PersonalConnectorError,
  createPersonalConnectorRegistry,
} from "../../src/index.js";
import { CONNECTOR_NOW, connectorHarness, connectorRequest } from "../fixtures/personal-connector-sources.js";

const digest = (value: number): string => `sha256:${value.toString(16).padStart(64, "0")}`;

describe("Task 13 public registry projection", () => {
  it("rejects injected source objects", async () => {
    const harness = await connectorHarness();
    try {
      expect(() => createPersonalConnectorRegistry({ sources: { portfolio: { read: async () => ({}) } } }))
        .toThrow(new PersonalConnectorConfigError());
    } finally { harness.db.close(); }
  });

  it("projects requested fields and skips empty-scope source access", async () => {
    const calls = { count: 0 };
    const harness = await connectorHarness({ orca_calls: calls });
    try {
      expect((await harness.registry.inspect({
        connector_id: "orca", scopes: ["orca.connectivity.read"], fields: ["connected"],
      })).values).toEqual({ connected: true });
      expect(await harness.registry.inspect({ connector_id: "orca", scopes: [], fields: [] }))
        .toMatchObject({ state: "no_data", reason: "no_scope", values: {} });
      expect(calls.count).toBe(1);
    } finally { harness.db.close(); }
  });

  it.each([
    [{ kind: "search" as const, query: "fixture" }, "second_brain.search.read", ["sb_search", "sb_read_page"]],
    [{ kind: "page" as const, page_id: "wiki/principle" }, "second_brain.page.read", ["sb_read_page"]],
    [{ kind: "recent" as const, days: 7 }, "second_brain.recent.read", ["sb_recent_changes", "sb_read_page"]],
    [{ kind: "conflicts" as const }, "second_brain.conflict.read", ["sb_open_conflicts", "sb_read_page"]],
  ])("maps configured Second Brain operation %s", async (operation, scope, expected) => {
    const memory_calls: { methods: ("sb_search" | "sb_read_page" | "sb_recent_changes" | "sb_open_conflicts")[] } = { methods: [] };
    const harness = await connectorHarness({ operation, memory_calls });
    try {
      expect(harness.registry.list().find(item => item.id === "second_brain")?.scopes).toEqual([scope]);
      await harness.registry.inspect({ connector_id: "second_brain", scopes: [scope], fields: [] });
      expect(memory_calls.methods).toEqual(expected);
    } finally { harness.db.close(); }
  });

  it("rejects fields outside the requested scope before source access", async () => {
    const calls = { count: 0 };
    const harness = await connectorHarness({ orca_calls: calls });
    try {
      await expect(harness.registry.inspect({
        connector_id: "orca", scopes: ["orca.identity.read"], fields: ["connected"],
      })).rejects.toMatchObject({ code: "PERSONAL_CONNECTOR_REQUEST_INVALID" });
      expect(calls.count).toBe(0);
    } finally { harness.db.close(); }
  });

  it("uses signed portfolio report time for stable identity", async () => {
    const reportedAt = new Date(CONNECTOR_NOW.getTime() - 60_000).toISOString();
    const early = await connectorHarness({ portfolio_reported_at: reportedAt, portfolio_received_at: new Date(CONNECTOR_NOW.getTime() - 30_000) });
    const late = await connectorHarness({ portfolio_reported_at: reportedAt, portfolio_received_at: CONNECTOR_NOW });
    try {
      const first = await early.registry.inspect(connectorRequest("portfolio"));
      const second = await late.registry.inspect(connectorRequest("portfolio"));
      expect([second.observed_at, second.cursor, second.values.reported_at])
        .toEqual([first.observed_at, first.cursor, first.values.reported_at]);
    } finally { early.db.close(); late.db.close(); }
  });

  it("keeps historical timeline metadata readable", async () => {
    const harness = await connectorHarness();
    harness.db.db.prepare(`INSERT INTO control_command_requests(
      request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,
      expires_at,nonce,state,lease_fence,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "request:old", "git.push", 4, JSON.stringify({ task_id: "task:old" }), "{}", digest(9), 1, "fixture",
      "2020-01-01T00:00:00.000Z", "2026-08-30T00:00:00.000Z", "nonce:old", "pending", 0,
      "2020-01-01T00:00:00.000Z",
    );
    try {
      const result = await harness.registry.inspect(connectorRequest("task_timeline"));
      expect(result).toMatchObject({ state: "ready", reason: "current", freshness: "unknown" });
      expect(result.values.observed_at).toBe("2020-01-01T00:00:00.000Z");
    } finally { harness.db.close(); }
  });

  it("rejects hostile inputs and retains copied portfolio bytes", async () => {
    const hostile = Object.defineProperty({}, "clock", { enumerable: true, get: () => { throw new Error("attacker"); } });
    expect(() => createPersonalConnectorRegistry(hostile)).toThrow(new PersonalConnectorConfigError());
    const harness = await connectorHarness();
    harness.factory_input.portfolio.envelope.fill(0); harness.factory_input.portfolio.key.fill(0);
    try {
      await expect(harness.registry.inspect({ connector_id: "mac", scopes: [], fields: [] }))
        .rejects.toEqual(new PersonalConnectorError("PERSONAL_CONNECTOR_UNKNOWN"));
      expect(await harness.registry.inspect(connectorRequest("portfolio")))
        .toMatchObject({ state: "ready", reason: "current" });
    } finally { harness.db.close(); }
  });
});
