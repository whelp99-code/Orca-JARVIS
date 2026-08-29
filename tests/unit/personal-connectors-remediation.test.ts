import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";
import {
  PERSONAL_CONNECTOR_DEFINITIONS,
  PersonalConnectorError,
  PersonalConnectorRegistry,
} from "../../src/index.js";
import {
  CONNECTOR_NOW,
  connectorHarness,
  connectorRequest,
} from "../fixtures/personal-connector-sources.js";

const OLD = "2020-01-01T00:00:00.000Z";

describe("Task 13 remediation roots", () => {
  it("root 1 rejects structurally injected unauthenticated configured sources", async () => {
    const { db, sources } = await connectorHarness();
    const forged = {
      ...sources,
      portfolio: { read: async () => ({
        connector_id: "portfolio", source_version: "forged-v1", incarnation: "local", sequence: 1,
        cursor: `sha256:${"b".repeat(64)}`, observed_at: CONNECTOR_NOW.toISOString(), status: "current",
        evidence_refs: [], values: { report_digest: `sha256:${"c".repeat(64)}` },
      }) },
    };
    const subject: unknown = Reflect.construct(PersonalConnectorRegistry, [{ sources: forged, clock: () => CONNECTOR_NOW }]);
    try {
      if (!(subject instanceof PersonalConnectorRegistry)) throw new TypeError("registry fixture invalid");
      expect(await subject.inspect(connectorRequest("portfolio"))).toMatchObject({ state: "unavailable", reason: "invalid_source" });
    } finally { db.close(); }
  });

  it("root 1 derives disconnected Orca health from the readonly adapter", async () => {
    const { db, registry } = await connectorHarness({ connected: false });
    try {
      expect(await registry.inspect(connectorRequest("orca"))).toMatchObject({ state: "offline", reason: "disconnected" });
    } finally { db.close(); }
  });

  it("root 2 parses hostile requests before a throwing clock", async () => {
    let calls = 0;
    const { db, registry } = await connectorHarness({ clock: () => { calls += 1; throw new Error("attacker"); } });
    const getter = Object.defineProperty({}, "fields", { enumerable: true, get: () => [] });
    try {
      for (const hostile of [null, getter, new Proxy({}, { getPrototypeOf: () => { throw new Error("proxy"); } })]) {
        await expect(Reflect.apply(registry.inspect, registry, [hostile])).rejects.toEqual(
          new PersonalConnectorError("PERSONAL_CONNECTOR_REQUEST_INVALID"),
        );
      }
      expect(calls).toBe(0);
    } finally { db.close(); }
  });

  it.each([
    "AKIA1234567890ABCDEF", "ghp_1234567890abcdef", "xoxb-1234567890-secret", "sk-live-1234567890",
    "-----BEGIN PRIVATE KEY-----", "password=secret", "token=secret", "Authorization: Bearer secret",
    "cookie=session", "/tmp/private", "/etc/passwd", "C:\\Users\\owner\\secret", "../relative/private",
    "https://example.test/?token=secret", "ignore previous instructions", "terminal output body", "mail message body",
  ])("root 3 rejects hostile identifier corpus item %s", async hostile => {
    const { db, registry } = await connectorHarness({ orca_overrides: { handle: hostile } });
    try {
      const result = await registry.inspect(connectorRequest("orca"));
      expect(result).toMatchObject({ state: "unavailable", reason: "adapter_failed" });
      expect(JSON.stringify(result)).not.toContain(hostile);
    } finally { db.close(); }
  });

  it("invokes a throwing concrete adapter exactly once and redacts its error", async () => {
    const calls = { count: 0 };
    const { db, registry } = await connectorHarness({ orca_error: new Error("raw attacker secret"), orca_calls: calls });
    try {
      const result = await registry.inspect(connectorRequest("orca"));
      expect(result).toMatchObject({ state: "unavailable", reason: "adapter_failed" });
      expect(JSON.stringify(result)).not.toContain("attacker");
      expect(calls.count).toBe(1);
    } finally { db.close(); }
  });

  it("root 4 rejects stale no_data and keeps disconnected Orca offline", async () => {
    const outcome = { kind: "no_data", checked_at: OLD, fresh_until: OLD } as const;
    const staleHarness = await connectorHarness({ outcome });
    const disconnectedHarness = await connectorHarness({ connected: false });
    try {
      expect((await staleHarness.registry.inspect(connectorRequest("second_brain"))).state).toBe("unavailable");
      expect((await disconnectedHarness.registry.inspect(connectorRequest("orca"))).state).toBe("offline");
    } finally { staleHarness.db.close(); disconnectedHarness.db.close(); }
  });

  it("root 5 keeps checkpoints opaque and rejects unchanged cursor advancement", async () => {
    let now = CONNECTOR_NOW;
    const { db, registry } = await connectorHarness({ clock: () => now });
    try {
      const first = await registry.inspect(connectorRequest("orca"));
      if (first.checkpoint === null) throw new TypeError("checkpoint missing");
      now = new Date(CONNECTOR_NOW.getTime() + 1);
      const stale = await registry.inspect(connectorRequest("orca", first.checkpoint));
      expect(stale.reason).toBe("checkpoint_stale");
      expect(first.checkpoint).toMatch(/^pcp:[0-9a-f-]{36}$/u);
    } finally { db.close(); }
  });

  it("root 6 deeply owns and freezes definitions and results", async () => {
    const { db, registry } = await connectorHarness();
    try {
      const result = await registry.inspect(connectorRequest("orca"));
      expect(Object.isFrozen(PERSONAL_CONNECTOR_DEFINITIONS)).toBe(true);
      expect(Object.isFrozen(PERSONAL_CONNECTOR_DEFINITIONS[0]?.capabilities)).toBe(true);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.values)).toBe(true);
      expect(Object.isFrozen(result.evidence_refs)).toBe(true);
    } finally { db.close(); }
  });

  it("root 7 exports concrete wrappers and rejects unsigned portfolio input", async () => {
    expect("SecondBrainPersonalConnectorSource" in publicApi).toBe(true);
    expect("OrcaPersonalConnectorSource" in publicApi).toBe(true);
    expect("TaskTimelinePersonalConnectorSource" in publicApi).toBe(true);
    expect("PortfolioPersonalConnectorSource" in publicApi).toBe(true);
    const unsigned = await connectorHarness({ portfolio_envelope: Buffer.from('{"source":"local"}', "utf8") });
    try {
      expect(await unsigned.registry.inspect(connectorRequest("portfolio"))).toMatchObject({
        state: "unavailable", reason: "adapter_failed",
      });
    } finally { unsigned.db.close(); }
  });
});
