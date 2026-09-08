import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { requireCorrectionCancellationAccepted, submitDatabaseCorrectionCancellation } from "../../src/memory-correction-cancellation-submit.js";
import { MemoryCorrectionCancellationIssuer } from "../../src/memory-correction-cancellation-issuer.js";
import { revokeMemoryEffectDelegationKey } from "../../src/memory-effect-delegation.js";
import { consumeSecondBrainContract } from "../../src/second-brain-contract.js";
import { createSecondBrainTransport, normalizeSecondBrainToolSchemas, SecondBrainTransportError } from "../../src/second-brain-transport.js";
import { cancellationDatabaseFixture } from "../fixtures/memory-cancellation-db.js";
import { cleanupFixtures, fixture, options } from "../fixtures/second-brain-transport-harness.js";

const contract = JSON.parse(readFileSync("contracts/second-brain-mcp-v5.json", "utf8"));
const happy = contract.tools.sb_submit_cancellation.happy;
const transports: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { await Promise.allSettled(transports.splice(0).map(t => t.close())); cleanupFixtures(); });

it("pins eleven schema7 tools and exact submission model", () => {
  expect(consumeSecondBrainContract("contracts/second-brain-mcp-v5.json")).toMatchObject({ schemaVersion: 7, toolCount: 11 });
  const tools = Object.entries(contract.tools).map(([name, value]) => ({ name, inputSchema: structuredClone((value as any).arguments) }));
  expect(normalizeSecondBrainToolSchemas(tools, contract)).toBe(true);
  tools.find(t => t.name === "sb_submit_cancellation")!.inputSchema.required = [];
  expect(normalizeSecondBrainToolSchemas(tools, contract)).toBe(false);
});

it.each(["task32-schema4", "remember-schema5", "cancellation-schema6"] as const)("rejects submission on %s before launch", async profile => {
  let launches = 0;
  const t = createSecondBrainTransport({ contractProfile: profile, execFile: () => { launches++; throw new Error("forbidden"); } });
  transports.push(t);
  await expect(t.call("sb_submit_cancellation", happy.arguments)).rejects.toMatchObject({ code: "SECOND_BRAIN_CONTRACT_PROFILE_REQUIRED" });
  expect(launches).toBe(0);
});

it("submits with schema7 and validates only exact pending acceptance", async () => {
  const t = createSecondBrainTransport(options(fixture({ emptyResponse: { method: "sb_submit_cancellation", value: happy.raw_response } }),
    { contractProfile: "cancellation-submit-schema7" }));
  transports.push(t);
  const result = await t.call("sb_submit_cancellation", happy.arguments);
  expect(result.kind).toBe("data");
  if (result.kind !== "data") throw new Error("missing acceptance");
  expect(requireCorrectionCancellationAccepted(result.value, happy.arguments.intent, new Date(happy.raw_response.accepted_at))).toEqual(happy.raw_response);
});

it.each([['intent_id', 'other'], ['state', 'provider_local_suppressed'], ['tombstone_sequence', 0],
  ['provider_instance_id', 'other'], ['original_request_id', 'other'], ['accepted_at', '2099-01-01T00:00:00.000Z'], ['proof', {}]])(
  "rejects unbound or completed acceptance %s", (field, value) => {
    expect(() => requireCorrectionCancellationAccepted({ ...happy.raw_response, [field as string]: value },
      happy.arguments.intent, new Date(happy.raw_response.accepted_at))).toThrow();
  });

it("runs final authority check after startup and does not publish on refusal", async () => {
  const child = fixture();
  const t = createSecondBrainTransport(options(child, { contractProfile: "cancellation-submit-schema7" }));
  transports.push(t);
  let checks = 0;
  await expect(t.call("sb_submit_cancellation", happy.arguments, { beforeSend: () => {
    checks++; throw new SecondBrainTransportError("REVOKED", "cancelled", { generation: 1 });
  } })).rejects.toMatchObject({ code: "REVOKED", disposition: "cancelled" });
  expect(checks).toBe(1);
  expect(readFileSync(child.receipt, "utf8")).not.toContain("sb_submit_cancellation");
});

it("revalidates the persisted DB intent after asynchronous transport waits", async () => {
  const f = await cancellationDatabaseFixture();
  try {
    let published = 0;
    const transport = { call: async (_method: any, _args: any, callOptions: any) => {
      revokeMemoryEffectDelegationKey(f.db, f.runtime.signing_key_id);
      callOptions.beforeSend(); published++;
      return { kind: "data" as const, value: happy.raw_response };
    }, restart: async () => undefined, close: async () => undefined, diagnostics: () => [] };
    await expect(submitDatabaseCorrectionCancellation(new MemoryCorrectionCancellationIssuer(f.db, f.runtime.clock),
      f.record.correction_id, f.runtime.signing_key_id, f.runtime.private_key, transport, f.runtime.clock))
      .rejects.toMatchObject({ code: "MEMORY_CANCELLATION_AUTHORITY_CHANGED" });
    expect(published).toBe(0);
    expect(f.db.db.prepare("SELECT count(*) AS n FROM memory_correction_cancellation_intents").get()).toEqual({ n: 1 });
  } finally { await f.close(); }
});


it.each([{}, { ...happy.arguments, extra: true }, { intent: { oversized: "x".repeat(16_384) } }])(
  "rejects malformed or oversized submission arguments before launch", async args => {
    let launches = 0;
    const t = createSecondBrainTransport({ contractProfile: "cancellation-submit-schema7",
      execFile: () => { launches++; throw new Error("forbidden"); } });
    transports.push(t);
    await expect(t.call("sb_submit_cancellation", args)).rejects.toBeInstanceOf(SecondBrainTransportError);
    expect(launches).toBe(0);
  });
