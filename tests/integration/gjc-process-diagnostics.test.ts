import { describe, expect, it } from "vitest";
import { GjcCoordinatorClient, spawnGjc } from "../../src/gjc.js";

function childClient(source: string, maxBytes = 65536): GjcCoordinatorClient {
  return new GjcCoordinatorClient(run => spawnGjc({
    ...run, argv: [process.execPath, "--input-type=module", "-e", source],
  }), false, 5000, maxBytes);
}

describe("GJC diagnostics through real child process pipes", () => {
  it("does not expose credentials printed by an exiting process", async () => {
    const client = childClient(`
      process.stdin.resume();
      process.stdin.on('end', () => {
        process.stderr.write('Authorization: Bearer FAKE_PIPE_SECRET\nunlabelled FAKE_PIPE_SECRET');
        process.exitCode = 1;
      });
    `);
    await expect(client.call(process.cwd(), { tool: "status", arguments: {} }))
      .rejects.toMatchObject({ code: "GJC_MCP_NONZERO", message: "GJC_MCP_NONZERO" });
  });

  it("retains successful protocol responses", async () => {
    const client = childClient(`
      process.stdin.resume();
      process.stdin.on('end', () => {
        console.log(JSON.stringify({jsonrpc:'2.0', id:1, result:{protocolVersion:'2024-11-05',
          serverInfo:{name:'gjc-coordinator-mcp',version:'0.11.8'}}}));
        console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{content:[{type:'text',text:'{"ok":true}'}]}}));
      });
    `);
    await expect(client.call(process.cwd(), { tool: "status", arguments: {} })).resolves.toEqual({ ok: true });
  });

  it("bounds stderr from the real process", async () => {
    const client = childClient(`
      process.stdin.resume();
      process.stdin.on('end', () => process.stderr.write('x'.repeat(4096)));
    `, 128);
    await expect(client.call(process.cwd(), { tool: "status", arguments: {} }))
      .rejects.toMatchObject({ code: "GJC_MCP_OUTPUT_LIMIT", message: "GJC_MCP_OUTPUT_LIMIT" });
  });
});
