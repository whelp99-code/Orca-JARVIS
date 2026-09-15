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
function producerTools(): readonly unknown[] {
  const fixture: unknown = JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8"));
  if (typeof fixture !== "object" || fixture === null) return [];
  const tools = Reflect.get(fixture, "tools");
  if (typeof tools !== "object" || tools === null) return [];
  return Object.entries(tools).map(([name, tool]) => ({ name,
    inputSchema: typeof tool === "object" && tool !== null ? Reflect.get(tool, "arguments") : undefined }));
}
const ACTUAL_TASK10_HANDSHAKE = JSON.stringify({
  initialize: {
    protocolVersion: SECOND_BRAIN_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: "second-brain", version: "0.1.0" },
  },
  tools_list: { tools: producerTools() },
});

function actualProducerRunner(
  status = "2026-08-28T11:00:00+00:00 run fixture ok pages=1 conflicts=0 errors=0\n",
): SecondBrainReadinessRunner {
  return {
    executable: async () => "available",
    configuration: async () => "valid",
    run: async command => command === "status"
      ? { kind: "ok", stdout: status }
      : { kind: "ok", stdout: JSON.stringify([
      { name: "python", status: "pass", detail: "app 1.0.0" },
      { name: "vault", status: "pass", detail: "mode=0o500" },
      { name: "scheduler-assets", status: "warn", detail: "deploy/systemd" },
    ]) },
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
      input_schemas_compatible: false,
      output_schemas_compatible: false,
      status_operational: true,
      doctor_operational: true,
      read_authorization: "unauthorized",
      write_authorization: "unauthorized",
      data_state: "unknown",
    });
    const report = evaluateSecondBrainReadiness(observation, NOW);
    expect(report).toMatchObject({
      readiness: "unavailable",
      stages: {
        protocol_compatible: { state: "unknown", reason: "protocol_unknown" },
        operational: { state: "blocked", reason: "protocol_incompatible" },
        authorized: { state: "unauthorized" },
      },
    });
  });

  it.each([
    ["2026-08-28T11:00:00Z run fixture ok pages=1 conflicts=0 errors=0", "success_attempted", null],
    ["2026-08-28T11:00:00Z run fixture ok pages=0 conflicts=0 errors=0", "success_attempted", null],
    ["no runs", "missing", null],
  ])("keeps historical status %s out of current data state", async (status, attempt, success) => {
    const observation = await runtimeSecondBrainReadinessProbe(actualProducerRunner(status)).inspect();
    expect(observation.data_state).toBe("unknown");
    expect(observation.refresh.kind).toBe(attempt);
    expect(observation.last_successful_refresh_at).toBe(success);
  });

  it("does not treat the producer's stage start timestamp as refresh completion", async () => {
    // pipeline._run_locked logs `started`; its ledger records a separate `finished_at`.
    const observation = await runtimeSecondBrainReadinessProbe(actualProducerRunner()).inspect();
    expect(observation.refresh).toEqual({ kind: "success_attempted", attempted_at: "2026-08-28T11:00:00.000Z" });
    expect(observation.last_successful_refresh_at).toBeNull();
    const report = evaluateSecondBrainReadiness(observation, NOW);
    expect(report.stages.last_successful_refresh.state).toBe("missing");
    expect(report.stages.freshness).toMatchObject({ state: "unknown", reason: "successful_refresh_missing" });
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
