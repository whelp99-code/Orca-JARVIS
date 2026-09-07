import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { consumeSecondBrainContract } from "../../src/second-brain-contract.js";
import { createSecondBrainTransport, normalizeSecondBrainToolSchemas,
  type SecondBrainExecFileOptions } from "../../src/second-brain-transport.js";
import { cleanupFixtures, fixture, options, writeRequest } from "../fixtures/second-brain-transport-harness.js";

const transports: Array<{ close(): Promise<void> }> = [];
beforeEach(() => { vi.stubEnv("JARVIS_SECOND_BRAIN_CONTRACT_PROFILE", undefined); });
afterEach(async () => { await Promise.allSettled(transports.splice(0).map(item => item.close())); cleanupFixtures(); vi.unstubAllEnvs(); });
function contract(name: "v1" | "v3"): any {
  return JSON.parse(readFileSync(`contracts/second-brain-mcp-${name}.json`, "utf8"));
}
function tools(name: "v1" | "v3"): Array<Record<string, any>> {
  return Object.entries(contract(name).tools).map(([toolName, tool]) => ({ name: toolName,
    inputSchema: structuredClone((tool as Record<string, unknown>).arguments) }));
}
function multilineWrite(): Readonly<Record<string, unknown>> {
  const request = structuredClone(writeRequest().request) as Record<string, unknown>;
  request.schema_version = 3; request.body_profile = "plain-text-v1";
  request.payload = { content: "첫 번째 줄\n\n두 번째 줄\r\n세 번째 줄\r네 번째 줄" };
  const base = Object.fromEntries(Object.entries(request).filter(([key]) => !["request_id", "request_digest"].includes(key)));
  const hash = createHash("sha256").update("orca-jarvis/memory-write-request/v3\0").update(canonicalize(base)).digest("hex");
  request.request_digest = `sha256:${hash}`; request.request_id = `memreq:pos:v3:${hash}`;
  return { request };
}

describe("explicit remember schema 5 transport profile", () => {
  it("pins the separate artifact and preserves the schema 4 artifact", () => {
    expect(consumeSecondBrainContract("contracts/second-brain-mcp-v1.json")).toMatchObject({ schemaVersion: 4,
      digest: "ae2e4b4f41ade29e8781e47e60dad6ddb17ed8cea516b82ccd16454acd5dc3e0" });
    expect(consumeSecondBrainContract("contracts/second-brain-mcp-v3.json")).toMatchObject({ schemaVersion: 5, toolCount: 9 });
    expect(() => createSecondBrainTransport({ contractPath: "contracts/second-brain-mcp-v3.json" }))
      .toThrow("SECOND_BRAIN_CONTRACT_MISMATCH");
    expect(() => createSecondBrainTransport({ contractProfile: "remember-schema5", contractPath: "contracts/second-brain-mcp-v1.json" }))
      .toThrow("SECOND_BRAIN_CONTRACT_MISMATCH");
  });

  it("pins production environment opt-in at construction and keeps restarts on that profile", async () => {
    vi.stubEnv("JARVIS_SECOND_BRAIN_CONTRACT_PROFILE", "remember-schema5");
    const value = fixture(); const launches: SecondBrainExecFileOptions[] = [];
    const transport = createSecondBrainTransport(options(value, { execFile: (file, args, childOptions) => {
      launches.push(childOptions); return execFile(file, [...args], childOptions);
    } })); transports.push(transport);
    vi.stubEnv("JARVIS_SECOND_BRAIN_CONTRACT_PROFILE", "task32-schema4");
    await expect(transport.call("sb_write_request", multilineWrite())).resolves.toMatchObject({ kind: "data", value: { schema_version: 3 } });
    await transport.restart();
    await expect(transport.call("sb_write_request", multilineWrite())).resolves.toMatchObject({ kind: "data", value: { schema_version: 3 } });
    expect(launches.map(item => item.env.SB_MCP_CONTRACT_PROFILE)).toEqual(["remember-schema5", "remember-schema5"]);
  });

  it.each(["", "schema5", " remember-schema5", "remember-schema5\n", "task32-schema4,remember-schema5"])(
    "rejects malformed production profile %j before spawning", value => {
      vi.stubEnv("JARVIS_SECOND_BRAIN_CONTRACT_PROFILE", value); let launches = 0;
      expect(() => createSecondBrainTransport({ execFile: () => { launches += 1; throw new Error("must not run"); } }))
        .toThrow("SECOND_BRAIN_CONTRACT_PROFILE_INVALID");
      expect(launches).toBe(0);
    });

  it("lets explicit caller options preserve schema 4 under a schema 5 environment", async () => {
    vi.stubEnv("JARVIS_SECOND_BRAIN_CONTRACT_PROFILE", "remember-schema5");
    const value = fixture(); const transport = createSecondBrainTransport(options(value, { contractProfile: "task32-schema4" }));
    transports.push(transport);
    await expect(transport.call("sb_write_request", multilineWrite())).rejects.toMatchObject({ code: "SECOND_BRAIN_CONTRACT_PROFILE_REQUIRED" });
    await expect(transport.call("sb_search", { query: "legacy" })).resolves.toMatchObject({ kind: "data" });
  });

  it("requires explicit profile before spawning a process for a V3 request", async () => {
    const value = fixture(); let launches = 0;
    const transport = createSecondBrainTransport(options(value, { execFile: (file, args, childOptions) => {
      launches += 1; return execFile(file, [...args], childOptions);
    } })); transports.push(transport);
    await expect(transport.call("sb_write_request", multilineWrite())).rejects.toMatchObject({
      code: "SECOND_BRAIN_CONTRACT_PROFILE_REQUIRED", disposition: "fatal" });
    expect(launches).toBe(0); expect(readFileSync(value.receipt, "utf8")).toBe("");
  });

  it("launches only the selected profile and delivers the V3 identity with no conversion", async () => {
    const value = fixture({ recordArguments: true }); const launches: SecondBrainExecFileOptions[] = [];
    const transport = createSecondBrainTransport(options(value, { contractProfile: "remember-schema5",
      execFile: (file, args, childOptions) => { launches.push(childOptions); return execFile(file, [...args], childOptions); },
    })); transports.push(transport);
    const request = multilineWrite();
    await expect(transport.call("sb_write_request", request)).resolves.toMatchObject({ kind: "data", value: {
      schema_version: 3, request_id: (request.request as Record<string, unknown>).request_id,
      request_digest: (request.request as Record<string, unknown>).request_digest,
    } });
    expect(launches).toHaveLength(1); expect(launches[0]?.env).toEqual({
      SB_CONFIG: value.config, SB_MCP_CONTRACT_PROFILE: "remember-schema5" });
    const received = JSON.parse(readFileSync(value.receipt, "utf8").trim());
    expect(received.arguments).toEqual(request);
    await expect(transport.call("sb_write_request", writeRequest())).resolves.toMatchObject({ kind: "data" });
    await expect(transport.call("sb_write_request", { request: contract("v3").vectors.correction.request }))
      .resolves.toMatchObject({ kind: "data" });
  });

  it.each([
    ["remember-schema5", "task32-schema4"], ["task32-schema4", "remember-schema5"],
  ] as const)("rejects provider %s to %s schema mismatch before any tool call", async (selected, provider) => {
    const value = fixture({ contractProfile: provider }); let launches = 0;
    const transport = createSecondBrainTransport(options(value, { contractProfile: selected,
      execFile: (file, args, childOptions) => { launches += 1; return execFile(file, [...args], childOptions); },
    })); transports.push(transport);
    await expect(transport.call("sb_search", { query: "no fallback" })).rejects.toMatchObject({ code: "SECOND_BRAIN_SCHEMA_MISMATCH" });
    expect(launches).toBe(1); expect(readFileSync(value.receipt, "utf8")).toBe("");
  });

  it("accepts the captured Python schema 5 tools/list and rejects body-profile authority drift", () => {
    // Captured from the real stdio provider in the multiline remember acceptance run.
    const observed = JSON.parse(readFileSync("tests/fixtures/second-brain-schema5-tools.json", "utf8"));
    expect(normalizeSecondBrainToolSchemas(observed.tools, contract("v3"))).toBe(true);
    expect(normalizeSecondBrainToolSchemas(observed.tools, contract("v1"))).toBe(false);
    const write = observed.tools.find((item: Record<string, unknown>) => item.name === "sb_write_request");
    expect(write).toBeDefined();
    write.inputSchema.$defs.MemoryRememberRequestV3Model.properties.body_profile.const = "plain-text-v2";
    expect(normalizeSecondBrainToolSchemas(observed.tools, contract("v3"))).toBe(false);
  });

  it("normalizes the measured schema 5 alias without dropping V1 or V3 authority fields", () => {
    const observed = tools("v3");
    const write = observed.find(item => item.name === "sb_write_request");
    expect(write).toBeDefined(); if (write === undefined) return;
    const schema = write.inputSchema;
    const union = structuredClone(schema.properties.request);
    union.discriminator.mapping = { "1": "#/$defs/MemoryWriteRequestModel",
      "2": "#/$defs/MemoryEffectWriteRequestV2", "3": "#/$defs/MemoryRememberRequestV3Model" };
    schema.$defs.MemoryRememberWriteRequest = union;
    schema.properties.request = { $ref: "#/$defs/MemoryRememberWriteRequest" };
    expect(normalizeSecondBrainToolSchemas(observed, contract("v3"))).toBe(true);
    schema.properties.request = { $ref: "#/$defs/MemoryWriteRequestModel" };
    expect(normalizeSecondBrainToolSchemas(observed, contract("v3"))).toBe(false);
    schema.properties.request = { $ref: "#/$defs/MemoryRememberWriteRequest" };
    union.discriminator.mapping["3"] = "#/$defs/MemoryWriteRequestModel";
    expect(normalizeSecondBrainToolSchemas(observed, contract("v3"))).toBe(false);
    union.discriminator.mapping["3"] = "#/$defs/MemoryRememberRequestV3Model";
    schema.$defs.MemoryWriteRequestModel.properties.schema_version.const = 3;
    expect(normalizeSecondBrainToolSchemas(observed, contract("v3"))).toBe(false);
  });

  it("binds write profiles to their exact schemas while preserving all read schemas", () => {
    const old = tools("v1"); const current = tools("v3");
    expect(normalizeSecondBrainToolSchemas(current, contract("v3"))).toBe(true);
    expect(normalizeSecondBrainToolSchemas(old, contract("v3"))).toBe(false);
    expect(normalizeSecondBrainToolSchemas(current, contract("v1"))).toBe(false);
    expect(current.filter(item => item.name !== "sb_write_request"))
      .toEqual(old.filter(item => item.name !== "sb_write_request"));
    const changed = structuredClone(current);
    const write = changed.find(item => item.name === "sb_write_request");
    expect(write).toBeDefined(); if (write === undefined) return;
    write.inputSchema.properties.request.oneOf.pop();
    expect(normalizeSecondBrainToolSchemas(changed, contract("v3"))).toBe(false);
  });
});
