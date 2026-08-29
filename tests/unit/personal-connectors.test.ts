import { describe, expect, it } from "vitest";
import {
  createPersonalConnectorRegistry,
  PERSONAL_CONNECTOR_DEFINITIONS,
  PERSONAL_CONNECTOR_IDS,
  PersonalConnectorError,
  type PersonalConnectorAdapters,
  type PersonalConnectorId,
  type PersonalConnectorReadRequest,
  type PersonalSourceSnapshot,
} from "../../src/index.js";

const NOW = new Date("2026-08-28T12:00:00.000Z");
const snapshot = (overrides: Partial<PersonalSourceSnapshot> = {}): PersonalSourceSnapshot => ({
  schema_version: 1,
  source_version: "source-v1",
  incarnation: "incarnation-1",
  sequence: 1,
  cursor: "cursor-1",
  observed_at: NOW.toISOString(),
  status: "current",
  evidence_refs: ["evidence:1"],
  values: {},
  ...overrides,
});
const adapters = (value: unknown = snapshot()): PersonalConnectorAdapters => ({
  second_brain: { read: async () => value },
  orca: { read: async () => value },
  task_timeline: { read: async () => value },
  portfolio: { read: async () => value },
});
const registry = (value: unknown = snapshot(), now = NOW) => createPersonalConnectorRegistry({ adapters: adapters(value), clock: () => now });
const request = (id: PersonalConnectorId, checkpoint?: string): PersonalConnectorReadRequest => {
  const definition = PERSONAL_CONNECTOR_DEFINITIONS.find(item => item.id === id);
  if (definition === undefined) throw new TypeError("fixture definition missing");
  return {
    connector_id: id,
    scopes: definition.scopes,
    fields: definition.allowed_fields,
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
};

describe("personal connector registry", () => {
  it("enumerates four configured adapters and three fail-closed slots", () => {
    // Given: the canonical registry.
    // When: connector metadata is listed.
    const listed = registry().list();
    // Then: exact IDs, configuration, and immutable scope tables are exposed.
    expect(PERSONAL_CONNECTOR_IDS).toEqual(["second_brain", "orca", "task_timeline", "portfolio", "calendar", "mail", "messenger"]);
    expect(listed.map(item => [item.id, item.configured])).toEqual([
      ["second_brain", true], ["orca", true], ["task_timeline", true], ["portfolio", true],
      ["calendar", false], ["mail", false], ["messenger", false],
    ]);
    expect(listed.find(item => item.id === "portfolio")?.freshness).toEqual({ live_ms: 90_000, stale_ms: 300_000 });
    expect(listed.filter(item => !item.configured).every(item => item.scopes.length === 0 && item.allowed_fields.length === 0)).toBe(true);
  });

  it.each([
    ["current", "ready", "current"],
    ["no_data", "no_data", "current_empty"],
    ["stale", "stale", "source_stale"],
    ["offline", "offline", "source_offline"],
    ["unavailable", "unavailable", "source_unavailable"],
  ] as const)("preserves %s as %s rather than fabricating success", async (status, state, reason) => {
    // Given: a measured current source outcome.
    // When: the configured source is inspected.
    const result = await registry(snapshot({ status })).inspect(request("second_brain"));
    // Then: its distinct state and evidence are preserved.
    expect(result).toMatchObject({ state, reason, observed_at: NOW.toISOString(), checked_at: NOW.toISOString() });
    expect(result.evidence.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.checkpoint).toBeTypeOf("string");
  });

  it.each([
    [90_000, "ready"], [90_001, "stale"], [300_000, "stale"], [300_001, "offline"],
  ] as const)("uses the exact portfolio boundary at age %d", async (age, state) => {
    // Given: an authenticated projection-shaped source snapshot at the boundary.
    const observed = new Date(NOW.getTime() - age).toISOString();
    // When: portfolio freshness is measured with the injected clock.
    const result = await registry(snapshot({ observed_at: observed })).inspect(request("portfolio"));
    // Then: equality remains live/stale and only values beyond 300s are offline.
    expect(result.state).toBe(state);
  });

  it("rejects unknown and overbroad requests before adapter invocation", async () => {
    // Given: an adapter with an observable invocation count.
    let calls = 0;
    const configured = adapters();
    const subject = createPersonalConnectorRegistry({
      adapters: { ...configured, orca: { read: async () => { calls += 1; return snapshot(); } } },
      clock: () => NOW,
    });
    // When/Then: unknown IDs and preview/body scope fail before invocation.
    await expect(subject.inspect({ connector_id: "contacts", scopes: [], fields: [] })).rejects.toEqual(
      new PersonalConnectorError("PERSONAL_CONNECTOR_UNKNOWN"),
    );
    await expect(subject.inspect({ ...request("orca"), fields: ["preview"] })).rejects.toMatchObject({
      code: "PERSONAL_CONNECTOR_REQUEST_INVALID",
    });
    expect(calls).toBe(0);
  });

  it("keeps calendar, mail, and messenger unavailable without invoking providers", async () => {
    // Given: the three intentionally unconfigured slots.
    // When: each slot is inspected.
    const results = await Promise.all((["calendar", "mail", "messenger"] as const).map(id => registry().inspect(request(id))));
    // Then: each is unavailable/not_configured with no fabricated observation.
    expect(results.map(item => [item.connector_id, item.state, item.reason])).toEqual([
      ["calendar", "unavailable", "not_configured"], ["mail", "unavailable", "not_configured"],
      ["messenger", "unavailable", "not_configured"],
    ]);
    expect(results.every(item => item.observed_at === null && item.checkpoint === null)).toBe(true);
  });

  it("accepts exact replay and rejects changed, rollback, and wrong-source checkpoints", async () => {
    // Given: a valid current checkpoint.
    const first = await registry().inspect(request("orca"));
    if (first.checkpoint === null) throw new TypeError("fixture checkpoint missing");
    // When: exact, changed, rollback, and cross-source replays are attempted.
    const exact = await registry().inspect(request("orca", first.checkpoint));
    const changed = await registry(snapshot({ values: { connected: true } })).inspect(request("orca", first.checkpoint));
    const rollback = await registry(snapshot({ sequence: 0 })).inspect(request("orca", first.checkpoint));
    const changedVersion = await registry(snapshot({ source_version: "source-v2", sequence: 2 })).inspect(request("orca", first.checkpoint));
    const changedIncarnation = await registry(snapshot({ incarnation: "incarnation-2", sequence: 2 })).inspect(request("orca", first.checkpoint));
    const wrong = await registry().inspect(request("portfolio", first.checkpoint));
    const decoded = Buffer.from(first.checkpoint, "base64url").toString("utf8");
    const tampered = Buffer.from(decoded.replace(/sha256:([0-9a-f])/u, (_match, nibble: string) => `sha256:${nibble === "0" ? "1" : "0"}`)).toString("base64url");
    const malformed = await registry().inspect(request("orca", tampered));
    // Then: only exact replay is idempotent.
    expect(exact.evidence.digest).toBe(first.evidence.digest);
    expect([changed.reason, rollback.reason, changedVersion.reason, changedIncarnation.reason, wrong.reason, malformed.reason]).toEqual([
      "replay_conflict", "checkpoint_stale", "checkpoint_mismatch", "checkpoint_mismatch", "checkpoint_invalid", "checkpoint_invalid",
    ]);
  });

  it.each([
    [{ ...snapshot(), preview: "terminal prose" }],
    [{ ...snapshot(), values: { secret: "sk-live-secret" } }],
    [{ ...snapshot(), values: { terminal_id: "sk-live-secret-value" } }],
    [{ ...snapshot(), values: { terminal_id: "/home/owner/private" } }],
    [Object.create({ inherited: true })],
  ])("rejects overbroad, secret-keyed, and custom-prototype source values", async value => {
    // Given: an invalid adapter boundary value.
    // When: it crosses the source boundary.
    const result = await registry(value).inspect(request("orca"));
    // Then: it becomes a fixed invalid source without leaking the value.
    expect(result).toMatchObject({ state: "unavailable", reason: "invalid_source", values: {} });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("rejects getters, proxies, adapter throws, future observations, invalid clocks, and oversized checkpoints", async () => {
    // Given: hostile adapter outputs and invalid time/checkpoint inputs.
    const getter = Object.defineProperty({}, "schema_version", { enumerable: true, get: () => 1 });
    const proxy = new Proxy({}, { ownKeys: () => { throw new TypeError("proxy trap"); } });
    const throwing = createPersonalConnectorRegistry({
      adapters: { ...adapters(), orca: { read: async () => { throw new TypeError("raw secret"); } } }, clock: () => NOW,
    });
    // When: each boundary is inspected.
    const results = await Promise.all([
      registry(getter).inspect(request("orca")), registry(proxy).inspect(request("orca")), throwing.inspect(request("orca")),
      registry(snapshot({ observed_at: new Date(NOW.getTime() + 1).toISOString() })).inspect(request("orca")),
      registry(snapshot(), new Date(Number.NaN)).inspect(request("orca")),
      registry().inspect(request("orca", "x".repeat(4_097))),
    ]);
    // Then: every case fails closed with stable reasons and no raw throw.
    expect(results.map(item => item.reason)).toEqual([
      "invalid_source", "invalid_source", "adapter_failed", "invalid_source", "invalid_clock", "checkpoint_invalid",
    ]);
    expect(results[4]?.checked_at).toBeNull();
  });
});
