import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";
import { createPersonalConnectorRegistry } from "../../src/index.js";
import { CONNECTOR_NOW, connectorHarness, connectorRequest } from "../fixtures/personal-connector-sources.js";

const insertRequest = (db: Awaited<ReturnType<typeof connectorHarness>>["db"], id: string) => {
  db.db.prepare(`INSERT INTO control_command_requests(
    request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,
    expires_at,nonce,state,lease_fence,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    `request:${id}`, "git.push", 4, JSON.stringify({ task_id: `task:${id}` }), "{}", `sha256:${id.padStart(64, "0")}`,
    1, "fixture", CONNECTOR_NOW.toISOString(), "2026-08-30T00:00:00.000Z", `nonce:${id}`, "pending", 0,
    CONNECTOR_NOW.toISOString(),
  );
};

const terminal = (index: number) => ({
  handle: `terminal-${index}`, ptyId: `pty-${index}`, incarnationId: `incarnation-${index}`,
  worktreeId: "worktree-1", worktreePath: "/fixture", title: null, connected: true, writable: false,
  lastOutputAt: CONNECTOR_NOW.getTime(), preview: null,
});

describe("Task 13 third remediation required contract B", () => {
  it("accepts natural search text and absolute space-bearing Orca argv", async () => {
    const harness = await connectorHarness();
    try {
      for (const query of ["what should I do next", "下一步做什么", "project: alpha, beta?"]) {
        expect(() => createPersonalConnectorRegistry({
          ...harness.factory_input,
          second_brain: { ...harness.factory_input.second_brain, operation: { kind: "search", query } },
        })).not.toThrow();
      }
      const selector = "/home/jm/Project Alpha; opaque";
      const calls: string[][] = [];
      const registry = createPersonalConnectorRegistry({
        ...harness.factory_input,
        orca: { runner: async (args: readonly string[]) => {
          calls.push([...args]); return JSON.stringify({ ok: true, result: { terminals: [] } });
        }, environment: "local", worktree: selector },
      });
      await registry.inspect({ connector_id: "orca", scopes: ["orca.connectivity.read"], fields: [] });
      expect(calls).toEqual([["terminal", "list", "--worktree", selector, "--json"]]);
    } finally { harness.db.close(); }
  });

  it.each([33, 10_000, 150_000])("rejects %i Orca terminals before source traversal or spread", async size => {
      const harness = await connectorHarness();
      const payload = JSON.stringify({ ok: true, result: { terminals: Array.from({ length: size }, (_, index) => terminal(index)) } });
      const registry = createPersonalConnectorRegistry({
        ...harness.factory_input,
        orca: { ...harness.factory_input.orca, runner: async () => payload },
      });
      try {
        const result = await registry.inspect(connectorRequest("orca"));
        expect(result).toMatchObject({ state: "unavailable", reason: "source_budget_exceeded", values: {}, evidence_refs: [] });
      } finally { harness.db.close(); }
  });

  it("enforces global timeline task event evidence decision and call bounds", async () => {
    const taskOverflow = await connectorHarness();
    for (let index = 0; index < 9; index += 1) insertRequest(taskOverflow.db, String(index + 1));
    try {
      expect(await taskOverflow.registry.inspect(connectorRequest("task_timeline"))).toMatchObject({
        state: "unavailable", reason: "source_budget_exceeded", values: {}, evidence_refs: [],
      });
    } finally { taskOverflow.db.close(); }

    const eventOverflow = await connectorHarness();
    insertRequest(eventOverflow.db, "events");
    const insertEvent = eventOverflow.db.db.prepare(`INSERT INTO control_events(
      event_id,schema_version,event_type,source,subject,correlation_id,causation_id,payload_json,payload_digest,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    for (let index = 0; index < 65; index += 1) insertEvent.run(
      `event:${index}`, 1, "control.command.approved", "fixture", "request:events", "request:events", null,
      "{}", `sha256:${index.toString(16).padStart(64, "0")}`, CONNECTOR_NOW.toISOString(),
    );
    try {
      expect(await eventOverflow.registry.inspect(connectorRequest("task_timeline"))).toMatchObject({
        state: "unavailable", reason: "source_budget_exceeded", values: {}, evidence_refs: [],
      });
    } finally { eventOverflow.db.close(); }
  });

  it("publishes runtime list as the only configured definition authority", async () => {
    expect("PERSONAL_CONNECTOR_DEFINITIONS" in publicApi).toBe(false);
    const harness = await connectorHarness({ operation: { kind: "page", page_id: "wiki/principle" } });
    try {
      const memory = harness.registry.list().find(item => item.id === "second_brain");
      expect(memory).toMatchObject({ capabilities: ["read_page"], scopes: ["second_brain.page.read"] });
      expect(memory?.allowed_fields).not.toContain("conflict_id");
    } finally { harness.db.close(); }
  });

  it("keeps every public connector integration test within 160 pure lines and columns", () => {
    const paths = [
      "tests/integration/personal-connectors-public.test.ts",
      "tests/integration/personal-connectors-public-authority.test.ts",
      "tests/integration/personal-connectors-public-checkpoints.test.ts",
      "tests/integration/personal-connectors-public-parser.test.ts",
    ];
    const offenders = paths.flatMap(path => {
      const lines = readFileSync(path, "utf8").split("\n");
      const pure = lines.filter(line => line.trim() !== "" && !line.trimStart().startsWith("//")).length;
      const maximum = Math.max(...lines.map(line => line.length));
      return pure > 160 || maximum > 160 ? [{ path, pure, maximum }] : [];
    });
    expect(offenders).toEqual([]);
  });
});
