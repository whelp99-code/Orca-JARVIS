import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createSecondBrainTransport, normalizeSecondBrainToolSchemas } from "../../src/second-brain-transport.js";
import { cleanupFixtures, fixture, options } from "../fixtures/second-brain-transport-harness.js";

const contract: unknown = JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8"));
const transports: Array<{ close(): Promise<void> }> = [];
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
afterEach(async () => { await Promise.allSettled(transports.splice(0).map(item => item.close())); cleanupFixtures(); });

function canonicalTools(): Array<Record<string, unknown>> {
  if (!isRecord(contract) || !isRecord(contract.tools)) return [];
  return Object.entries(contract.tools).flatMap(([name, value]) => isRecord(value) ? [{ name, inputSchema: structuredClone(value.arguments) }] : []);
}
const PRODUCER_OUTPUTS: Readonly<Record<string, unknown>> = {
  sb_search: { $defs: { SearchHitDict: { properties: { page_id: { type: "string" }, section: { type: "string" }, snippet: { type: "string" }, score: { type: "number" } }, required: ["page_id", "section", "snippet", "score"], type: "object" } }, additionalProperties: { items: { $ref: "#/$defs/SearchHitDict" }, type: "array" }, type: "object" },
  sb_read_page: { additionalProperties: { anyOf: [{ additionalProperties: { type: "string" }, type: "object" }, { type: "string" }] }, type: "object" },
  sb_recent_changes: { additionalProperties: { items: { additionalProperties: { type: "string" }, type: "object" }, type: "array" }, type: "object" },
  sb_open_conflicts: { additionalProperties: { items: { additionalProperties: { type: "string" }, type: "object" }, type: "array" }, type: "object" },
  sb_remember: { additionalProperties: { type: "string" }, type: "object" },
};
function producerTools(): Array<Record<string, unknown>> { return canonicalTools().map(tool => ({ ...tool, description: "bounded metadata", outputSchema: structuredClone(PRODUCER_OUTPUTS[String(tool.name)]) })); }

describe("frozen Second Brain boundary", () => {
  it("accepts only enumerated producer schema syntax and rejects authority drift", () => {
    const titled = canonicalTools(); if (isRecord(titled[0]?.inputSchema)) titled[0].inputSchema.title = "KnownModel"; expect(normalizeSecondBrainToolSchemas(titled, contract)).toBe(true);
    const mutations: Array<(tools: Array<Record<string, unknown>>) => void> = [
      tools => { if (isRecord(tools[0]?.inputSchema)) tools[0].inputSchema.additionalProperties = true; },
      tools => { if (isRecord(tools[0]?.inputSchema)) tools[0].inputSchema.pattern = "extra"; },
      tools => { const schema = tools[1]?.inputSchema; if (isRecord(schema) && isRecord(schema.properties) && isRecord(schema.properties.id)) schema.properties.id.minLength = 1; },
      tools => { if (tools[0]) tools[0].extra = true; }, tools => { tools[0] = structuredClone(tools[1] ?? {}); },
    ];
    for (const mutate of mutations) { const tools = canonicalTools(); mutate(tools); expect(normalizeSecondBrainToolSchemas(tools, contract)).toBe(false); }
  });

  it("freezes every producer output schema while bounding discarded description metadata", () => {
    const actual = producerTools(); expect(normalizeSecondBrainToolSchemas(actual, contract)).toBe(true); const mutations: Array<(schema: Record<string, unknown>) => void> = [schema => { schema.additionalProperties = true; }, schema => { schema.required = ["drift"]; }, schema => { schema.properties = { drift: { type: "string" } }; }, schema => { schema.type = "array"; }, schema => { schema.unknown = true; }];
    for (const tool of actual) for (const mutate of mutations) { const changed = producerTools(); const target = changed.find(item => item.name === tool.name)?.outputSchema; if (isRecord(target)) mutate(target); expect(normalizeSecondBrainToolSchemas(changed, contract)).toBe(false); }
    const bounded = producerTools(); if (bounded[0]) bounded[0].description = "x".repeat(8_192); expect(normalizeSecondBrainToolSchemas(bounded, contract)).toBe(true); if (bounded[0]) bounded[0].description = "x".repeat(8_193); expect(normalizeSecondBrainToolSchemas(bounded, contract)).toBe(false);
  });

  it("accepts only bounded string title metadata at every enumerated schema level", () => {
    const valid = canonicalTools(); if (isRecord(valid[0]?.inputSchema)) valid[0].inputSchema.title = "root"; expect(normalizeSecondBrainToolSchemas(valid, contract)).toBe(true);
    const invalidRoot = canonicalTools(); if (isRecord(invalidRoot[0]?.inputSchema)) invalidRoot[0].inputSchema.title = { authority: true }; expect(normalizeSecondBrainToolSchemas(invalidRoot, contract)).toBe(false);
    const invalidProperty = canonicalTools(); const pageSchema = invalidProperty.find(tool => tool.name === "sb_read_page")?.inputSchema; if (isRecord(pageSchema) && isRecord(pageSchema.properties) && isRecord(pageSchema.properties.id)) pageSchema.properties.id.title = []; expect(normalizeSecondBrainToolSchemas(invalidProperty, contract)).toBe(false);
    const invalidOption = canonicalTools(); const rememberSchema = invalidOption.find(tool => tool.name === "sb_remember")?.inputSchema; if (isRecord(rememberSchema) && isRecord(rememberSchema.properties) && isRecord(rememberSchema.properties.title)) { delete rememberSchema.properties.title.type; rememberSchema.properties.title.anyOf = [{ type: "string", title: {} }, { type: "null" }]; } expect(normalizeSecondBrainToolSchemas(invalidOption, contract)).toBe(false);
    const oversized = canonicalTools(); if (isRecord(oversized[0]?.inputSchema)) oversized[0].inputSchema.title = "x".repeat(8_193); expect(normalizeSecondBrainToolSchemas(oversized, contract)).toBe(false);
  });

  it("enforces frozen arguments locally when producer schemas omit additionalProperties", async () => {
    const tools = canonicalTools(); for (const tool of tools) if (isRecord(tool.inputSchema)) delete tool.inputSchema.additionalProperties;
    const value = fixture({ tools }); const transport = createSecondBrainTransport(options(value)); transports.push(transport); await expect(transport.call("sb_search", { query: "ok" })).resolves.toMatchObject({ kind: "data" });
    for (const arguments_ of [{ query: "ok", unexpected: true }, { query: 1 }, {}]) await expect(transport.call("sb_search", arguments_)).rejects.toMatchObject({ code: "SECOND_BRAIN_INVALID_ARGUMENTS", disposition: "fatal" }); await expect(transport.call("sb_recent_changes", {})).resolves.toMatchObject({ kind: "data" });
  });
});
