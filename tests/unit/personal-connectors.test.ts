import { describe, expect, it } from "vitest";
import {
  PERSONAL_CONNECTOR_DEFINITIONS,
  PERSONAL_CONNECTOR_IDS,
  PersonalConnectorError,
} from "../../src/index.js";
import {
  CONNECTOR_NOW,
  connectorHarness,
  connectorRequest,
} from "../fixtures/personal-connector-sources.js";

describe("personal connector registry", () => {
  it("enumerates four verified sources and three immutable unavailable slots", async () => {
    // Given: concrete repository-backed connector wrappers.
    const { db, registry } = await connectorHarness();
    try {
      // When: immutable definitions are listed.
      const listed = registry.list();
      // Then: the exact seven slots and portfolio thresholds are fixed.
      expect(PERSONAL_CONNECTOR_IDS).toEqual([
        "second_brain", "orca", "task_timeline", "portfolio", "calendar", "mail", "messenger",
      ]);
      expect(listed.map(item => [item.id, item.configured])).toEqual([
        ["second_brain", true], ["orca", true], ["task_timeline", true], ["portfolio", true],
        ["calendar", false], ["mail", false], ["messenger", false],
      ]);
      expect(listed[3]?.freshness).toEqual({ live_ms: 90_000, stale_ms: 300_000 });
      expect(Object.isFrozen(listed)).toBe(true);
    } finally { db.close(); }
  });

  it("reads all four configured wrappers and keeps unavailable slots provider-free", async () => {
    // Given: actual Task11, Orca, timeline, and authenticated portfolio wrappers.
    const { db, registry } = await connectorHarness();
    try {
      // When: all exact slots are inspected.
      const results = await Promise.all(PERSONAL_CONNECTOR_IDS.map(id => registry.inspect(connectorRequest(id))));
      // Then: four are measured and three remain not configured.
      expect(results.slice(0, 4).map(item => item.state)).toEqual(["ready", "ready", "no_data", "ready"]);
      expect(results.slice(4).map(item => item.reason)).toEqual(["not_configured", "not_configured", "not_configured"]);
      expect(results.every(item => Object.isFrozen(item) && Object.isFrozen(item.values))).toBe(true);
    } finally { db.close(); }
  });

  it("keeps offline, unavailable, stale, and current no-data distinct", async () => {
    const outcomes = [
      { kind: "offline", code: "SECOND_BRAIN_CHILD_EXIT", checked_at: CONNECTOR_NOW.toISOString() },
      { kind: "unavailable", code: "SECOND_BRAIN_TIMEOUT", checked_at: CONNECTOR_NOW.toISOString() },
      { kind: "no_data", checked_at: CONNECTOR_NOW.toISOString(), fresh_until: CONNECTOR_NOW.toISOString() },
    ] as const;
    const states: string[] = [];
    for (const outcome of outcomes) {
      const { db, registry } = await connectorHarness({ outcome });
      try { states.push((await registry.inspect(connectorRequest("second_brain"))).state); } finally { db.close(); }
    }
    expect(states).toEqual(["offline", "unavailable", "no_data"]);
  });

  it.each([
    [90_000, "ready"], [90_001, "stale"], [300_000, "stale"], [300_001, "offline"],
  ] as const)("uses exact authenticated portfolio age boundary %d", async (age, state) => {
    const now = new Date(CONNECTOR_NOW.getTime() + age);
    const { db, registry } = await connectorHarness({ clock: () => now });
    try { expect((await registry.inspect(connectorRequest("portfolio"))).state).toBe(state); } finally { db.close(); }
  });

  it("rejects hostile requests before clock or source access", async () => {
    let clockCalls = 0;
    const { db, registry } = await connectorHarness({ clock: () => { clockCalls += 1; return CONNECTOR_NOW; } });
    const getter = Object.defineProperty({}, "connector_id", { enumerable: true, get: () => "orca" });
    const proxy = new Proxy({}, { ownKeys: () => { throw new TypeError("attacker"); } });
    try {
      for (const hostile of [null, getter, proxy, { connector_id: "orca", scopes: "bad", fields: [] }]) {
        await expect(Reflect.apply(registry.inspect, registry, [hostile])).rejects.toEqual(
          new PersonalConnectorError("PERSONAL_CONNECTOR_REQUEST_INVALID"),
        );
      }
      expect(clockCalls).toBe(0);
    } finally { db.close(); }
  });

  it("returns fixed invalid_clock without invoking a source", async () => {
    const { db, registry } = await connectorHarness({ clock: () => { throw new TypeError("attacker clock"); } });
    try {
      const result = await registry.inspect(connectorRequest("orca"));
      expect(result).toMatchObject({ state: "unavailable", reason: "invalid_clock", checked_at: null });
    } finally { db.close(); }
  });

  it("keeps opaque checkpoints server-side and rejects same-cursor advancement", async () => {
    let now = CONNECTOR_NOW;
    const { db, registry } = await connectorHarness({ clock: () => now });
    try {
      const first = await registry.inspect(connectorRequest("orca"));
      if (first.checkpoint === null) throw new TypeError("checkpoint missing");
      expect(first.checkpoint).toMatch(/^pcp:[0-9a-f-]{36}$/u);
      const exact = await registry.inspect(connectorRequest("orca", first.checkpoint));
      now = new Date(CONNECTOR_NOW.getTime() + 1);
      const stale = await registry.inspect(connectorRequest("orca", first.checkpoint));
      const wrong = await registry.inspect(connectorRequest("portfolio", first.checkpoint));
      expect(exact.checkpoint).toBe(first.checkpoint);
      expect([stale.reason, wrong.reason]).toEqual(["checkpoint_stale", "checkpoint_mismatch"]);
      expect(Buffer.from(first.checkpoint, "base64url").toString("utf8")).not.toContain("source_version");
    } finally { db.close(); }
  });

  it("rejects unknown IDs, overbroad fields, and unknown checkpoint handles", async () => {
    const { db, registry } = await connectorHarness();
    try {
      await expect(registry.inspect({ connector_id: "mac", scopes: [], fields: [] })).rejects.toMatchObject({
        code: "PERSONAL_CONNECTOR_UNKNOWN",
      });
      for (const field of ["preview", "body"]) {
        await expect(registry.inspect({ ...connectorRequest("orca"), fields: [field] })).rejects.toMatchObject({
          code: "PERSONAL_CONNECTOR_REQUEST_INVALID",
        });
      }
      expect((await registry.inspect(connectorRequest("orca", "pcp:00000000-0000-0000-0000-000000000000"))).reason)
        .toBe("checkpoint_invalid");
    } finally { db.close(); }
  });

  it("deep-freezes canonical definitions", () => {
    expect(Object.isFrozen(PERSONAL_CONNECTOR_DEFINITIONS)).toBe(true);
    expect(PERSONAL_CONNECTOR_DEFINITIONS.every(item => Object.isFrozen(item)
      && Object.isFrozen(item.capabilities) && Object.isFrozen(item.scopes)
      && Object.isFrozen(item.allowed_fields) && Object.isFrozen(item.freshness))).toBe(true);
  });
});
