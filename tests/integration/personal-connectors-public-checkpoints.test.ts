import { describe, expect, it } from "vitest";
import { PERSONAL_CONNECTOR_REGISTRY_SESSION } from "../../src/index.js";
import {
  CONNECTOR_NOW,
  connectorHarness,
  connectorSessionRequest,
} from "../fixtures/personal-connector-sources.js";

describe("Task 13 explicit checkpoint lifecycle", () => {
  it("bounds one active handle across repeated advancement", async () => {
    let now = CONNECTOR_NOW;
    const overrides: Record<string, unknown> = {};
    const harness = await connectorHarness({ clock: () => now, orca_overrides: overrides });
    try {
      let result = await harness.registry.inspect(connectorSessionRequest("orca"));
      for (let index = 1; index <= 2_000; index += 1) {
        if (result.checkpoint === null) throw new TypeError("checkpoint missing");
        overrides["handle"] = `terminal-${index + 1}`;
        now = new Date(CONNECTOR_NOW.getTime() + index);
        result = await harness.registry.inspect(connectorSessionRequest("orca", result.checkpoint));
      }
      expect(result.checkpoint).toMatch(/^pcp:1:[0-9a-f-]{36}:[0-9a-f-]{36}$/u);
      expect(PERSONAL_CONNECTOR_REGISTRY_SESSION).toEqual({
        version: 1, persistence: "process_local", restart: "handles_invalid", max_total: 4, max_per_connector: 1,
      });
    } finally { harness.db.close(); }
  });

  it("admits exactly four configured explicit sessions", async () => {
    const harness = await connectorHarness();
    try {
      const checkpoints = [];
      for (const id of ["second_brain", "orca", "task_timeline", "portfolio"] as const) {
        checkpoints.push((await harness.registry.inspect(connectorSessionRequest(id))).checkpoint);
      }
      expect(checkpoints).toHaveLength(PERSONAL_CONNECTOR_REGISTRY_SESSION.max_total);
      expect(checkpoints.every(checkpoint => checkpoint !== null)).toBe(true);
    } finally { harness.db.close(); }
  });

  it("permits one concurrent progression winner", async () => {
    let now = CONNECTOR_NOW;
    const overrides: Record<string, unknown> = {};
    const harness = await connectorHarness({ clock: () => now, orca_overrides: overrides });
    try {
      const first = await harness.registry.inspect(connectorSessionRequest("orca"));
      if (first.checkpoint === null) throw new TypeError("checkpoint missing");
      overrides["handle"] = "terminal-2"; now = new Date(CONNECTOR_NOW.getTime() + 1);
      const attempts = await Promise.all([
        harness.registry.inspect(connectorSessionRequest("orca", first.checkpoint)),
        harness.registry.inspect(connectorSessionRequest("orca", first.checkpoint)),
      ]);
      expect(attempts.map(result => result.reason).sort()).toEqual(["checkpoint_invalid", "current"]);
      expect((await harness.registry.inspect(connectorSessionRequest("orca", first.checkpoint))).reason)
        .toBe("checkpoint_invalid");
    } finally { harness.db.close(); }
  });

  it("invalidates explicit handles after registry restart", async () => {
    const first = await connectorHarness();
    const result = await first.registry.inspect(connectorSessionRequest("orca"));
    first.db.close();
    if (result.checkpoint === null) throw new TypeError("checkpoint missing");
    const restarted = await connectorHarness();
    try {
      expect(await restarted.registry.inspect(connectorSessionRequest("orca", result.checkpoint)))
        .toMatchObject({ state: "unavailable", reason: "checkpoint_session_invalid" });
    } finally { restarted.db.close(); }
  });
});
