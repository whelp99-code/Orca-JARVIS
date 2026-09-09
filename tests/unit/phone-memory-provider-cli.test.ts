import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parsePhoneGatewayCli, startPhoneGatewayCli } from "../../src/phone-gateway-main.js";
import { openPhoneMemoryProviderCli } from "../../src/phone-memory-provider-cli.js";
import * as gateway from "../../src/phone-gateway.js";
import { memoryDatabase, closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
afterEach(() => vi.restoreAllMocks());

const base = ["--host", "127.0.0.1", "--port", "4176", "--upstream", "http://127.0.0.1:4173",
  "--static-root", "/fixture/static", "--env-file", "/fixture/phone.env"];
const fields = { "provider-verify-db": "/fixture/authority.sqlite", "provider-verify-agent": "agent:phone",
  "provider-verify-policy": "/fixture/policy.json", "provider-verify-provider": "provider:test",
  "provider-verify-spool": "/fixture/scoped", "provider-verify-dispatch-spool": "/fixture/dispatch",
  "provider-verify-review-spool": "/fixture/review" };
const args = (values: Record<string, string>) => [...base, ...Object.entries(values).flatMap(([key, value]) => [`--${key}`, value])];
it("requires a complete explicit configuration and supplies no session", () => {
  expect(parsePhoneGatewayCli(base).memoryProvider).toBeUndefined();
  const parsed = parsePhoneGatewayCli(args(fields)).memoryProvider!;
  expect(parsed.database_path).toBe(fields["provider-verify-db"]);
  expect(parsed.roots).toEqual({ dispatch: "/fixture/dispatch", review: "/fixture/review" });
  expect(parsed).not.toHaveProperty("authenticated_session");
  for (const missing of Object.keys(fields)) {
    const incomplete = { ...fields } as Record<string, string>; delete incomplete[missing];
    expect(() => parsePhoneGatewayCli(args(incomplete))).toThrow("PHONE_NOT_READY");
  }
});
it.each([["provider-verify-db", "relative.sqlite"], ["provider-verify-policy", ""],
  ["provider-verify-agent", "user:fake"], ["provider-verify-provider", "provider:bad\n"],
  ["provider-verify-spool", "/bad\0path"]])("rejects malformed %s", (field, value) => {
  expect(() => parsePhoneGatewayCli(args({ ...fields, [field]: value }))).toThrow("PHONE_NOT_READY");
});
it("does not create a missing authority database", async () => {
  const f = await memoryDatabase();
  try {
    const path = join(f.root, "missing.sqlite");
    const parsed = parsePhoneGatewayCli(args({ ...fields, "provider-verify-db": path })).memoryProvider!;
    expect(() => openPhoneMemoryProviderCli(parsed)).toThrow();
    expect(existsSync(path)).toBe(false);
  } finally { closeMemoryDatabase(f); }
});
it.each(["success", "server_failure", "output_failure"])("owns and closes the connection on %s", async mode => {
  const f = await memoryDatabase();
  try {
    const before = f.authority.db.prepare("SELECT total_changes() AS n").get();
    const close = vi.fn();
    vi.spyOn(gateway, "parsePhoneGatewayConfig").mockReturnValue({ publicOrigin: "https://fixture",
      publicHost: "fixture", ownerLogin: "fixture", sessionKey: Buffer.alloc(32), ownerDigest: Buffer.alloc(32) });
    const create = vi.spyOn(gateway, "createPhoneGatewayServer").mockImplementation(() => {
      if (mode === "server_failure") throw new Error("fixture startup failure");
      return { address: { host: "127.0.0.1", port: 4176, family: "IPv4" }, close };
    });
    const parsed = parsePhoneGatewayCli(args({ ...fields, "provider-verify-db": f.path }));
    const start = () => startPhoneGatewayCli(parsed, () => { if (mode === "output_failure") throw new Error("fixture output failure"); });
    if (mode === "success") { const running = start(); running.close(); running.close(); }
    else expect(start).toThrow("fixture");
    const options = create.mock.calls[0]![0].memoryProviderVerifier!;
    expect(options.authority).not.toBe(f.authority);
    expect(options.authority.db.open).toBe(false);
    expect(f.authority.db.open).toBe(true);
    expect(f.authority.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(close).toHaveBeenCalledTimes(mode === "server_failure" ? 0 : 1);
  } finally { closeMemoryDatabase(f); }
});
