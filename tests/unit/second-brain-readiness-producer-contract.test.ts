import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SECOND_BRAIN_REQUIRED_TOOLS,
  evaluateSecondBrainReadiness,
} from "../../src/second-brain-readiness.js";
import {
  runtimeSecondBrainReadinessProbe,
  type SecondBrainReadinessRunner,
} from "../../src/second-brain-readiness-runtime.js";
import { SECOND_BRAIN_PROTOCOL_VERSION } from "../../src/second-brain-transport.js";

const NOW = new Date("2026-08-28T12:00:00.000Z");
function writeInputSchema(): unknown {
  const fixture: unknown = JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8"));
  if (typeof fixture !== "object" || fixture === null) return undefined;
  const tools = Reflect.get(fixture, "tools"); const write = typeof tools === "object" && tools !== null ? Reflect.get(tools, "sb_write_request") : undefined;
  return typeof write === "object" && write !== null ? Reflect.get(write, "arguments") : undefined;
}
const ACTUAL_TASK10_HANDSHAKE = JSON.stringify({
  initialize: {
    protocolVersion: SECOND_BRAIN_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: "second-brain", version: "0.1.0" },
  },
  tools_list: {
    tools: [
      { name: "sb_open_conflicts", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
      { name: "sb_read_page", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
      { name: "sb_recent_changes", inputSchema: { type: "object", properties: { days: { default: 7, type: "integer" } }, required: [], additionalProperties: false } },
      { name: "sb_remember", inputSchema: { type: "object", properties: { content: { type: "string" }, title: { default: null, type: ["string", "null"] } }, required: ["content"], additionalProperties: false } },
      { name: "sb_search", inputSchema: { type: "object", properties: { limit: { default: 10, type: "integer" }, query: { type: "string" } }, required: ["query"], additionalProperties: false } },
      { name: "sb_write_request", inputSchema: writeInputSchema() },
    ],
  },
});

function actualProducerRunner(
  status = "2026-08-28T11:00:00+00:00 run fixture ok pages=1 conflicts=0 errors=0\n",
): SecondBrainReadinessRunner {
  return {
    executable: async () => "available",
    configuration: async () => "valid",
    run: async command => command === "status"
      ? { kind: "ok", stdout: status }
      : { kind: "ok", stdout: "" },
    handshake: async () => ({ kind: "ok", stdout: ACTUAL_TASK10_HANDSHAKE }),
  };
}

describe("actual Second Brain producer contracts", () => {
  it("retains Task 10 initialize and tools/list facts without inventing unavailable facts", async () => {
    const observation = await runtimeSecondBrainReadinessProbe(actualProducerRunner()).inspect();
    expect(observation).toMatchObject({
      contract_digest: null,
      protocol_version: SECOND_BRAIN_PROTOCOL_VERSION,
      tools: SECOND_BRAIN_REQUIRED_TOOLS,
      input_schemas_compatible: true,
      output_schemas_compatible: null,
      status_operational: null,
      doctor_operational: null,
      read_authorization: "unauthorized",
      write_authorization: "unauthorized",
      data_state: "unknown",
    });
    const report = evaluateSecondBrainReadiness(observation, NOW);
    expect(report).toMatchObject({
      readiness: "unavailable",
      stages: {
        protocol_compatible: { state: "unknown", reason: "protocol_unknown" },
        operational: { state: "unavailable", reason: "probe_facts_missing" },
        authorized: { state: "unauthorized" },
      },
    });
  });

  it.each([
    ["2026-08-28T11:00:00Z run fixture ok pages=1 conflicts=0 errors=0", "success", "2026-08-28T11:00:00.000Z"],
    ["2026-08-28T11:00:00Z run fixture ok pages=0 conflicts=0 errors=0", "success", "2026-08-28T11:00:00.000Z"],
    ["no runs", "missing", null],
  ])("keeps historical status %s out of current data state", async (status, attempt, success) => {
    const observation = await runtimeSecondBrainReadinessProbe(actualProducerRunner(status)).inspect();
    expect(observation.data_state).toBe("unknown");
    expect(observation.refresh.kind).toBe(attempt);
    expect(observation.last_successful_refresh_at).toBe(success);
  });

  it("never defaults successful processes with missing operational facts to green", () => {
    const report = evaluateSecondBrainReadiness({
      executable: "available",
      configuration: "valid",
      contract_digest: null,
      protocol_version: SECOND_BRAIN_PROTOCOL_VERSION,
      tools: SECOND_BRAIN_REQUIRED_TOOLS,
      schemas_compatible: true,
      status: "ok",
      doctor: "ok",
      handshake: "ok",
      read_authorization: "unauthorized",
      write_authorization: "unauthorized",
      data_state: "unknown",
      refresh: { kind: "missing" },
    }, NOW);
    expect(report.stages.operational).toMatchObject({ state: "unavailable", reason: "probe_facts_missing" });
    expect(report.readiness).toBe("unavailable");
  });
});
