import { afterEach, expect, it, vi } from "vitest";
import { parsePhoneGatewayCli, startPhoneGatewayCli } from "../../src/phone-gateway-main.js";
import * as gateway from "../../src/phone-gateway.js";
afterEach(() => vi.restoreAllMocks());

const base = ["--host", "127.0.0.1", "--port", "4176", "--upstream", "http://127.0.0.1:4173",
  "--static-root", "/fixture/static", "--env-file", "/fixture/phone.env"];
const fields = { "reconcile-db": "/fixture/authority.sqlite", "reconcile-agent": "agent:phone",
  "reconcile-policy": "/fixture/policy.json", "reconcile-provider": "provider:test", "reconcile-signing-key": "key:test",
  "reconcile-private-key": "/fixture/private.key", "reconcile-spool": "/fixture/scoped", "reconcile-dispatch-spool": "/fixture/dispatch", "reconcile-review-spool": "/fixture/review",
  "reconcile-launcher": "/fixture/launcher", "reconcile-provider-config": "/fixture/provider.toml",
  "reconcile-journal-contract": "/fixture/journal.json", "reconcile-read-contract": "/fixture/read.json" };
const args = (values: Record<string, string>) => [...base, ...Object.entries(values).flatMap(([key, value]) => [`--${key}`, value])];
it("keeps default disabled and assembles only an explicit complete configuration", () => {
  expect(parsePhoneGatewayCli(base).memoryReconcile).toBeUndefined();
  const parsed = parsePhoneGatewayCli(args(fields)).memoryReconcile!;
  expect(parsed.database_path).toBe(fields["reconcile-db"]);
  expect(parsed.agent_id).toBe("agent:phone");
  expect(parsed.memory.read_fence_config.private_key_path).toBe(fields["reconcile-private-key"]);
  expect(parsed.memory.journal_transport_options?.configPath).toBe(fields["reconcile-provider-config"]);
  expect(parsed.memory).not.toHaveProperty("authenticated_session");
});
it("rejects partial activation instead of silently falling back to the default", () => {
  for (const missing of Object.keys(fields)) {
    const incomplete = { ...fields } as Record<string, string>; delete incomplete[missing];
    expect(() => parsePhoneGatewayCli(args(incomplete))).toThrow("PHONE_NOT_READY");
  }
});
it("passes parsed scoped settings through the executable startup composition", async () => {
  const close = vi.fn();
  vi.spyOn(gateway, "parsePhoneGatewayConfig").mockReturnValue({ publicOrigin: "https://fixture",
    publicHost: "fixture", ownerLogin: "fixture", sessionKey: Buffer.alloc(32), ownerDigest: Buffer.alloc(32) });
  const create = vi.spyOn(gateway, "createPhoneGatewayServer").mockReturnValue({
    address: { host: "127.0.0.1", port: 4176, family: "IPv4" }, close,
  });
  const parsed = parsePhoneGatewayCli(args(fields)); const output: string[] = [];
  const running = await startPhoneGatewayCli(parsed, line => output.push(line));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ memoryReconcile: parsed.memoryReconcile }));
  expect(output).toEqual(["http://127.0.0.1:4176"]);
  running.close(); expect(close).toHaveBeenCalledOnce();
});
it.each([["reconcile-db", "relative.sqlite"], ["reconcile-policy", ""], ["reconcile-agent", "user:fake"],
  ["reconcile-provider", "provider:bad\n"], ["reconcile-launcher", "/bad\0path"], ["reconcile-signing-key", "key bad"]])(
  "rejects malformed explicit %s", (field, value) => {
    expect(() => parsePhoneGatewayCli(args({ ...fields, [field]: value }))).toThrow("PHONE_NOT_READY");
  });
