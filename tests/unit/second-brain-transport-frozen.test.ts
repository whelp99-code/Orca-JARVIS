import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createSecondBrainTransport, normalizeSecondBrainToolSchemas } from "../../src/second-brain-transport.js";
import { cleanupFixtures, fixture, options } from "../fixtures/second-brain-transport-harness.js";

const contract: unknown = JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8"));
const transports: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { await Promise.allSettled(transports.splice(0).map(item => item.close())); cleanupFixtures(); });

function canonicalTools(): Array<Record<string, unknown>> {
  const tools = (contract as { tools: Record<string, { arguments: unknown }> }).tools;
  return Object.entries(tools).map(([name, value]) => ({ name, inputSchema: structuredClone(value.arguments) }));
}

describe("frozen Second Brain boundary", () => {
  it("accepts only enumerated producer schema syntax and rejects authority drift", () => {
    const titled = canonicalTools(); const schema = titled[0]?.inputSchema as Record<string, unknown>; schema.title = "KnownModel";
    expect(normalizeSecondBrainToolSchemas(titled, contract)).toBe(true);
    const mutations: Array<(tools: Array<Record<string, unknown>>) => void> = [
      tools => { (tools[0]?.inputSchema as Record<string, unknown>).additionalProperties = true; },
      tools => { (tools[0]?.inputSchema as Record<string, unknown>).pattern = "extra"; },
      tools => { const properties = (tools[1]?.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties; if (properties.id) properties.id.minLength = 1; },
      tools => { if (tools[0]) tools[0].extra = true; },
      tools => { tools[0] = structuredClone(tools[1] ?? {}); },
    ];
    for (const mutate of mutations) { const tools = canonicalTools(); mutate(tools); expect(normalizeSecondBrainToolSchemas(tools, contract)).toBe(false); }
  });

  it("enforces frozen arguments locally when producer schemas omit additionalProperties", async () => {
    const tools = canonicalTools(); for (const tool of tools) delete (tool.inputSchema as Record<string, unknown>).additionalProperties;
    const value = fixture({ tools }); const transport = createSecondBrainTransport(options(value)); transports.push(transport);
    await expect(transport.call("sb_search", { query: "ok" })).resolves.toMatchObject({ kind: "data" });
    for (const arguments_ of [{ query: "ok", unexpected: true }, { query: 1 }, {}]) await expect(transport.call("sb_search", arguments_)).rejects.toMatchObject({ code: "SECOND_BRAIN_INVALID_ARGUMENTS", disposition: "fatal" });
    await expect(transport.call("sb_recent_changes", {})).resolves.toMatchObject({ kind: "data" });
  });
});
