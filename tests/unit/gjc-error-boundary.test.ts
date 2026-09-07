import { describe, expect, it } from "vitest";
import { GjcCoordinatorClient } from "../../src/gjc.js";
import { JarvisError } from "../../src/db.js";

describe("GJC diagnostic boundary", () => {
  it.each([
    "token=FAKE_SECRET_SENTINEL",
    'password="FAKE_SECRET_SENTINEL with spaces"',
    "Authorization: Bearer FAKE_SECRET_SENTINEL",
    '{"api_key":"FAKE_SECRET_SENTINEL"}',
    "unlabelled credential FAKE_SECRET_SENTINEL\ncontinued diagnostic",
  ])("keeps arbitrary process stderr out of the public error: %s", async stderr => {
    const client = new GjcCoordinatorClient(async () => ({ stdout: "", stderr, exitCode: 1 }));
    await expect(client.call(process.cwd(), { tool: "status", arguments: {} }))
      .rejects.toMatchObject({ code: "GJC_MCP_NONZERO", message: "GJC_MCP_NONZERO" });
  });

  it("enforces output limits before forwarding a nonzero result", async () => {
    const client = new GjcCoordinatorClient(async () => ({ stdout: "", stderr: "x".repeat(33), exitCode: 1 }), false, 1000, 32);
    await expect(client.call(process.cwd(), { tool: "status", arguments: {} }))
      .rejects.toMatchObject({ code: "GJC_MCP_OUTPUT_LIMIT" });
  });

  it.each(["GJC_MCP_TIMEOUT", "GJC_MCP_SPAWN_FAILED", "GJC_MCP_OUTPUT_LIMIT"])(
    "retains the known runner failure code %s without its external message", async code => {
      const client = new GjcCoordinatorClient(async () => { throw new JarvisError(code, "FAKE_SECRET_SENTINEL"); });
      await expect(client.call(process.cwd(), { tool: "status", arguments: {} }))
        .rejects.toMatchObject({ code, message: code });
    },
  );

  it("maps unknown runner failures to a bounded diagnostic", async () => {
    const client = new GjcCoordinatorClient(async () => { throw new Error("FAKE_SECRET_SENTINEL"); });
    await expect(client.call(process.cwd(), { tool: "status", arguments: {} }))
      .rejects.toMatchObject({ code: "GJC_MCP_RUNNER_FAILED", message: "GJC_MCP_RUNNER_FAILED" });
  });
});
