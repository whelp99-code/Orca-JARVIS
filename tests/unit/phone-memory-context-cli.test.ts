import { afterEach, expect, it, vi } from "vitest";
import { parsePhoneGatewayCli, startPhoneGatewayCli } from "../../src/phone-gateway-main.js";
import * as gateway from "../../src/phone-gateway.js";
afterEach(() => vi.restoreAllMocks());

const base = ["--host", "127.0.0.1", "--port", "4176", "--upstream", "http://127.0.0.1:4173",
  "--static-root", "/fixture/static", "--env-file", "/fixture/phone.env"];
const fields = { "memory-db": "/fixture/authority.sqlite", "memory-agent": "agent:phone",
  "memory-policy": "/fixture/policy.json", "memory-provider": "provider:test", "memory-signing-key": "key:test",
  "memory-private-key": "/fixture/private.key", "memory-projection-key": "/fixture/projection.key",
  "memory-launcher": "/fixture/launcher", "memory-provider-config": "/fixture/provider.toml",
  "memory-contract": "/fixture/contract.json" };
const args = (values: Record<string, string>) => [...base, ...Object.entries(values).flatMap(([key, value]) => [`--${key}`, value])];
it("keeps default disabled and assembles only an explicit complete configuration", () => {
  expect(parsePhoneGatewayCli(base).memoryContext).toBeUndefined();
  const parsed = parsePhoneGatewayCli(args(fields)).memoryContext!;
  expect(parsed.database_path).toBe(fields["memory-db"]);
  expect(parsed.agent_id).toBe("agent:phone");
  expect(parsed.memory.read_fence_config.private_key_path).toBe(fields["memory-private-key"]);
  expect(parsed.memory.transport_options?.configPath).toBe(fields["memory-provider-config"]);
  expect(parsed.memory).not.toHaveProperty("authenticated_session");
});
it("rejects partial activation instead of silently falling back to the default", () => {
  for (const missing of Object.keys(fields)) {
    const incomplete = { ...fields } as Record<string, string>; delete incomplete[missing];
    expect(() => parsePhoneGatewayCli(args(incomplete))).toThrow("PHONE_NOT_READY");
  }
});
it("passes parsed scoped settings through the executable startup composition", () => {
  const close = vi.fn();
  vi.spyOn(gateway, "parsePhoneGatewayConfig").mockReturnValue({ publicOrigin: "https://fixture",
    publicHost: "fixture", ownerLogin: "fixture", sessionKey: Buffer.alloc(32), ownerDigest: Buffer.alloc(32) });
  const create = vi.spyOn(gateway, "createPhoneGatewayServer").mockReturnValue({
    address: { host: "127.0.0.1", port: 4176, family: "IPv4" }, close,
  });
  const parsed = parsePhoneGatewayCli(args(fields)); const output: string[] = [];
  const running = startPhoneGatewayCli(parsed, line => output.push(line));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ memoryContext: parsed.memoryContext }));
  expect(output).toEqual(["http://127.0.0.1:4176"]);
  running.close(); expect(close).toHaveBeenCalledOnce();
});
it.each([["memory-db", "relative.sqlite"], ["memory-policy", ""], ["memory-agent", "user:fake"],
  ["memory-provider", "provider:bad\n"], ["memory-launcher", "/bad\0path"], ["memory-signing-key", "key bad"]])(
  "rejects malformed explicit %s", (field, value) => {
    expect(() => parsePhoneGatewayCli(args({ ...fields, [field]: value }))).toThrow("PHONE_NOT_READY");
  });
