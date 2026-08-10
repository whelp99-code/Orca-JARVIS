import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { GJC_ENV, GjcCoordinatorClient } from "../../src/gjc.js";

const response = (body: unknown) => `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(body) }] } })}\n`;
describe("GJC coordinator client", () => {
  it("uses an injected runner and performs only initialize plus one tool call", async () => {
    let captured: { argv: readonly string[]; env: Record<string, string>; stdin: string } | undefined;
    const client = new GjcCoordinatorClient(async run => { captured = run; return { stdout: response({ status: "completed" }), exitCode: 0 }; });
    await expect(client.call(mkdtempSync(`${tmpdir()}/gjc-`), { tool: "status", arguments: {} })).resolves.toEqual({ status: "completed" });
    expect(captured?.argv).toEqual(["gjc", "mcp-serve", "coordinator"]); expect(captured?.env).toMatchObject({ GJC_COORDINATOR_MCP_PROFILE: GJC_ENV.GJC_COORDINATOR_MCP_PROFILE, GJC_COORDINATOR_MCP_REPO: GJC_ENV.GJC_COORDINATOR_MCP_REPO }); expect(captured?.env.GJC_COORDINATOR_MCP_MUTATIONS).toBeUndefined(); const lines = captured?.stdin.trim().split("\n") ?? []; expect(lines).toHaveLength(3); expect(JSON.parse(lines[1]!).method).toBe("notifications/initialized"); expect(JSON.parse(lines[2]!).params.name).toBe("status");
  });
  it("fails closed for malformed, tool error, denied mutations, timeout and nonzero", async () => {
    const cwd = mkdtempSync(`${tmpdir()}/gjc-`); const bad = new GjcCoordinatorClient(async () => ({ stdout: "not-json\n", exitCode: 0 })); await expect(bad.call(cwd, { tool: "status", arguments: {} })).rejects.toMatchObject({ code: "GJC_MCP_MALFORMED" });
    const error = new GjcCoordinatorClient(async () => ({ stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { isError: true, content: [{ type: "text", text: "{}" }] } })}\n`, exitCode: 0 })); await expect(error.call(cwd, { tool: "status", arguments: {} })).rejects.toMatchObject({ code: "GJC_MCP_TOOL_ERROR" });
    await expect(bad.call(cwd, { tool: "dispatch", arguments: {}, mutation: true })).rejects.toMatchObject({ code: "GJC_MUTATION_DENIED" });
    const nonzero = new GjcCoordinatorClient(async () => ({ stdout: "", stderr: "token=abc", exitCode: 1 })); await expect(nonzero.call(cwd, { tool: "status", arguments: {} })).rejects.toMatchObject({ code: "GJC_MCP_NONZERO" });
    const okFalse = new GjcCoordinatorClient(async () => ({ stdout: response({ ok: false }), exitCode: 0 })); await expect(okFalse.call(cwd, { tool: "status", arguments: {} })).rejects.toMatchObject({ code: "GJC_MCP_TOOL_ERROR" });
  });
});
