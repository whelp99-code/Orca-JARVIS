import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";
import { CONNECTOR_NOW, connectorHarness, connectorRequest } from "../fixtures/personal-connector-sources.js";

const timelineRequest = {
  connector_id: "task_timeline",
  scopes: ["task_timeline.task.read", "task_timeline.event.read", "task_timeline.decision.read", "task_timeline.evidence.read"],
  fields: ["task_id", "event_id", "decision_id", "evidence_id", "observed_at"],
};

describe("Task 13 third remediation required contract A", () => {
  it("rejects exported registry prototype authority mutation and ES extension", async () => {
    const first = await connectorHarness();
    const second = await connectorHarness();
    const exported = Reflect.get(publicApi, "PersonalConnectorRegistry");
    const prototype = typeof exported === "function" ? Reflect.get(exported, "prototype") : undefined;
    const original = prototype === undefined ? undefined : Reflect.get(prototype, "inspect");
    try {
      expect(typeof exported === "undefined").toBe(true);
      let prototypeError = "none";
      try { Object.setPrototypeOf(first.registry, { inspect: async () => "forged" }); }
      catch (error) { prototypeError = error instanceof TypeError ? "TypeError" : "other"; }
      expect(prototypeError).toBe("TypeError");
      if (prototype !== undefined) {
        Reflect.set(prototype, "inspect", async () => "forged");
        const result: unknown = await Reflect.apply(second.registry.inspect, second.registry, [connectorRequest("orca")]);
        expect(result === "forged").toBe(false);
      }
    } finally {
      if (prototype !== undefined && original !== undefined) Reflect.set(prototype, "inspect", original);
      first.db.close(); second.db.close();
    }
  });

  it("keeps repeated checkpointless reads stateless", async () => {
    const harness = await connectorHarness();
    try {
      const first = await harness.registry.inspect(connectorRequest("portfolio"));
      const second = await harness.registry.inspect(connectorRequest("portfolio"));
      expect([first.reason, first.checkpoint, Reflect.get(first, "checkpoint_session")]).toEqual([
        "current", null, { mode: "stateless", version: 1, persistence: "process_local", handle: null },
      ]);
      expect([second.reason, second.checkpoint]).toEqual(["current", null]);
    } finally { harness.db.close(); }
  });

  it("keeps unchanged timeline identity exact from T to T plus one millisecond", async () => {
    let now = CONNECTOR_NOW;
    const harness = await connectorHarness({ clock: () => now });
    harness.db.db.prepare(`INSERT INTO control_command_requests(
      request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,
      expires_at,nonce,state,lease_fence,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "request:stable", "git.push", 4, JSON.stringify({ task_id: "task:stable" }), "{}", `sha256:${"4".repeat(64)}`,
      1, "fixture", "2020-01-01T00:00:00.000Z", "2026-08-30T00:00:00.000Z", "nonce:stable", "pending", 0,
      "2020-01-01T00:00:00.000Z",
    );
    try {
      const start = await harness.registry.inspect({ ...timelineRequest, checkpoint_session: { mode: "start", version: 1 } });
      now = new Date(CONNECTOR_NOW.getTime() + 1);
      const next = await harness.registry.inspect({
        ...timelineRequest, checkpoint_session: { mode: "continue", version: 1, handle: start.checkpoint },
      });
      expect(next).toMatchObject({ reason: "current", checkpoint: start.checkpoint, observed_at: start.observed_at });
      expect(next.checked_at).not.toBe(start.checked_at);
    } finally { harness.db.close(); }
  });
});
