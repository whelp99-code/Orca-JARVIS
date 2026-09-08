import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { requireCorrectionCancellationStatus } from "../../src/memory-correction-cancellation-status.js";
import { consumeSecondBrainContract } from "../../src/second-brain-contract.js";
import { createSecondBrainTransport, normalizeSecondBrainToolSchemas } from "../../src/second-brain-transport.js";
import { cleanupFixtures, fixture, options } from "../fixtures/second-brain-transport-harness.js";

const contract = JSON.parse(readFileSync("contracts/second-brain-mcp-v4.json", "utf8"));
const resultFixture = JSON.parse(readFileSync("contracts/cancellation-result-v1.json", "utf8"));
const happy = contract.tools.sb_cancellation_status.happy;
const verification = { now: new Date("2026-08-31T02:00:01.000Z"),
  provider_keys: new Map([[resultFixture.result.signing_key_id, resultFixture.provider_public_key]]),
  tombstone_sequence: happy.raw_response.tombstone_sequence, tombstone_set_root: happy.raw_response.tombstone_set_root };
const transports: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { await Promise.allSettled(transports.splice(0).map(item => item.close())); cleanupFixtures(); vi.unstubAllEnvs(); });

it("pins schema6 independently and retains schema4/5 counts", () => {
  expect(consumeSecondBrainContract("contracts/second-brain-mcp-v4.json")).toMatchObject({ schemaVersion: 6, toolCount: 10 });
  expect(consumeSecondBrainContract("contracts/second-brain-mcp-v3.json")).toMatchObject({ schemaVersion: 5, toolCount: 9 });
  expect(consumeSecondBrainContract("contracts/second-brain-mcp-v1.json")).toMatchObject({ schemaVersion: 4, toolCount: 9 });
  expect(() => createSecondBrainTransport({ contractPath: "contracts/second-brain-mcp-v4.json", contractProfile: "remember-schema5" }))
    .toThrow("SECOND_BRAIN_CONTRACT_MISMATCH");
});

it.each(["task32-schema4", "remember-schema5"] as const)("requires schema6 before launching from %s", async profile => {
  let launches = 0;
  const transport = createSecondBrainTransport({ contractProfile: profile,
    execFile: () => { launches += 1; throw new Error("must not launch"); } });
  transports.push(transport);
  await expect(transport.call("sb_cancellation_status", happy.arguments)).rejects.toMatchObject({ code: "SECOND_BRAIN_CONTRACT_PROFILE_REQUIRED" });
  expect(launches).toBe(0);
});

it("reads and validates the exact signed result through the selected transport", async () => {
  const child = fixture({ emptyResponse: { method: "sb_cancellation_status", value: happy.raw_response } });
  const transport = createSecondBrainTransport(options(child, { contractProfile: "cancellation-schema6" }));
  transports.push(transport);
  const response = await transport.call("sb_cancellation_status", happy.arguments);
  expect(response.kind).toBe("data");
  if (response.kind !== "data") throw new Error("missing result");
  const verified = requireCorrectionCancellationStatus(response.value, resultFixture.intent, verification);
  expect(verified).toEqual(happy.raw_response);
  expect(Object.isFrozen(verified)).toBe(true);
  await transport.restart();
  expect(await transport.call("sb_cancellation_status", happy.arguments)).toEqual(response);
});

it("accepts pending and not_found only without completion evidence", () => {
  const { result: _result, ...pending } = happy.raw_response;
  void _result;
  expect(requireCorrectionCancellationStatus({ ...pending, state: "suppression_pending" }, resultFixture.intent, verification).state)
    .toBe("suppression_pending");
  const { accepted_at: _accepted, ...missing } = pending;
  void _accepted;
  expect(requireCorrectionCancellationStatus({ ...missing, state: "not_found" }, resultFixture.intent, verification).state).toBe("not_found");
});

it.each([
  ["state", "generation_active"], ["intent_id", "other"], ["provider_instance_id", "other"],
  ["intent_digest", `sha256:${"0".repeat(64)}`], ["tombstone_sequence", 0],
  ["tombstone_set_root", `sha256:${"0".repeat(64)}`], ["result", undefined],
  ["accepted_at", "2026-08-31T00:02:00.000Z"], ["extra", "not allowed"],
])("rejects wrong status binding %s", (field, value) => {
  expect(() => requireCorrectionCancellationStatus({ ...happy.raw_response, [field]: value }, resultFixture.intent, verification)).toThrow();
});

it("rejects revoked result keys and forged nested signatures", () => {
  expect(() => requireCorrectionCancellationStatus(happy.raw_response, resultFixture.intent,
    { ...verification, revoked_provider_key_ids: new Set([resultFixture.result.signing_key_id]) })).toThrow();
  expect(() => requireCorrectionCancellationStatus({ ...happy.raw_response,
    result: { ...happy.raw_response.result, signature: "A".repeat(86) } }, resultFixture.intent, verification)).toThrow();
});

it("requires the new tool in schema6 and rejects input authority drift", () => {
  const tools = Object.entries(contract.tools).map(([name, value]) => ({ name, inputSchema: structuredClone((value as any).arguments) }));
  expect(normalizeSecondBrainToolSchemas(tools, contract)).toBe(true);
  expect(normalizeSecondBrainToolSchemas(tools.filter(item => item.name !== "sb_cancellation_status"), contract)).toBe(false);
  const status = tools.find(item => item.name === "sb_cancellation_status")!;
  status.inputSchema.required = ["intent_id"];
  expect(normalizeSecondBrainToolSchemas(tools, contract)).toBe(false);
});
