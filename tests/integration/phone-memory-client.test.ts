import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readPhoneMemoryContext } from "../../src/phone-memory-client.js";
import { createPhoneMemoryClientMcp } from "../../src/index.js";
import { prepareMemoryReference } from "../../src/memory-reference-context.js";
import { canonicalize } from "../../src/canonical.js";

const input = { query: "기억", limit: 8, max_bytes: 16384 };
const cookie = "c".repeat(43), csrf = "s".repeat(43);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function envelope() {
  const prepared = prepareMemoryReference({ outcome: { kind: "no_data", checked_at: new Date().toISOString(), fresh_until: new Date(Date.now() + 60000).toISOString() },
    query: input.query, now: new Date(), budgets: { max_records: 8, max_record_bytes: 4096, max_bytes: 15000 } });
  return { schema_version: 1, version: 1, ok: true, command: "memory.context", context: prepared.payload,
    context_digest: prepared.digest, context_bytes: prepared.bytes };
}
function signed(value: ReturnType<typeof envelope>) {
  const raw = canonicalize(value.context);
  value.context_digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  value.context_bytes = Buffer.byteLength(raw);
  return value;
}
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const root = mkdtempSync(join(tmpdir(), "phone-memory-client-")); chmodSync(root, 0o700);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  // Public, disposable TEST ONLY identity; never installed as an operational trust anchor.
  const cert = readFileSync(new URL("../fixtures/phone-memory-test-cert.pem", import.meta.url));
  const key = readFileSync(new URL("../fixtures/phone-memory-test-key.pem", import.meta.url));
  const ca = join(root, "ca.pem"); writeFileSync(ca, cert, { mode: 0o600 });
  let calls = 0;
  const server = createServer({ cert, key }, (req, res) => { calls++; handler(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
  const config = { origin: `https://127.0.0.1:${address.port}`, cookie_id: cookie, csrf_token: csrf, ca_file: ca };
  const credentials = join(root, "credentials.json");
  const save = () => writeFileSync(credentials, JSON.stringify(config), { mode: 0o600 }); save();
  return { root, credentials, config, save, calls: () => calls };
}
function reply(res: ServerResponse, value: unknown) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); }

describe("authenticated memory client over actual HTTPS", () => {
  it("sends only the fixed context request and rereads rotated local credentials", async () => {
    const requests: { url?: string; headers: IncomingMessage["headers"]; body: string }[] = [];
    const f = await fixture((req, res) => {
      let body = ""; req.on("data", data => { body += data; });
      req.on("end", () => { requests.push({ url: req.url, headers: req.headers, body }); reply(res, envelope()); });
    });
    expect((await readPhoneMemoryContext(f.credentials, input)).context).toMatchObject({ state: "empty", authority: "none" });
    f.config.cookie_id = "d".repeat(43); f.save();
    await readPhoneMemoryContext(f.credentials, input);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("/api/v1/memory/context");
    expect(JSON.parse(requests[0]!.body)).toEqual({ schema_version: 1, ...input });
    expect(requests[0]?.headers.cookie).toBe(`__Host-jarvis-phone=${cookie}`);
    expect(requests[1]?.headers.cookie).toBe(`__Host-jarvis-phone=${f.config.cookie_id}`);
    expect(requests[0]?.headers["tailscale-user-login"]).toBeUndefined();
    expect(requests[0]?.headers["x-jarvis-csrf"]).toBe(csrf);
  });
  it("rejects model supplied scope/URL fields before making a request", async () => {
    const f = await fixture((_req, res) => reply(res, envelope()));
    await expect(readPhoneMemoryContext(f.credentials, { ...input, origin: f.config.origin } as typeof input))
      .rejects.toThrow("MEMORY_CLIENT_INPUT_INVALID");
    expect(f.calls()).toBe(0);
  });
  it.each(["public", "symlink", "http", "untrusted_ca"])("rejects unsafe credentials: %s", async kind => {
    const f = await fixture((_req, res) => reply(res, envelope()));
    if (kind === "public") chmodSync(f.credentials, 0o644);
    if (kind === "symlink") { const link = join(f.root, "link.json"); symlinkSync(f.credentials, link); f.credentials = link; }
    if (kind === "http") { f.config.origin = f.config.origin.replace("https:", "http:"); f.save(); }
    if (kind === "untrusted_ca") writeFileSync(f.credentials, JSON.stringify({ origin: f.config.origin, cookie_id: cookie, csrf_token: csrf }));
    await expect(readPhoneMemoryContext(f.credentials, input)).rejects.toThrow("MEMORY_CLIENT_UNAVAILABLE");
    expect(f.calls()).toBe(0);
  });
  it.each(["redirect", "oversize", "truncated", "wrong_query", "bad_digest", "secret", "encoded_secret"])("rejects unsafe response: %s", async kind => {
    const f = await fixture((_req, res) => {
      if (kind === "redirect") { res.writeHead(302, { Location: "/other" }); res.end(); return; }
      if (kind === "truncated") { res.writeHead(200, { "Content-Type": "application/json", "Content-Length": 100 }); res.end("{}"); res.socket?.destroy(); return; }
      if (kind === "oversize") { reply(res, "x".repeat(input.max_bytes)); return; }
      const value = envelope();
      if (kind === "wrong_query") value.context = { ...value.context, query_digest: "sha256:" + "a".repeat(64) };
      signed(value);
      if (kind === "bad_digest") value.context_digest = "sha256:" + "0".repeat(64);
      if (kind === "secret" || kind === "encoded_secret") {
        value.context = { ...value.context, instruction: cookie }; signed(value);
        if (kind === "encoded_secret") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value).replace(cookie, "\\u0063".repeat(43))); return; }
      }
      reply(res, value);
    });
    await expect(readPhoneMemoryContext(f.credentials, input)).rejects.toThrow("MEMORY_CLIENT_UNAVAILABLE");
    expect(f.calls()).toBe(1);
  });
  it("cancels an in-flight call without retrying", async () => {
    let arrived!: () => void;
    const received = new Promise<void>(resolve => { arrived = resolve; });
    const f = await fixture(() => arrived());
    const abort = new AbortController();
    const result = readPhoneMemoryContext(f.credentials, input, abort.signal);
    const rejected = expect(result).rejects.toThrow("MEMORY_CLIENT_UNAVAILABLE");
    await received; abort.abort(); await rejected;
    expect(f.calls()).toBe(1);
  });
  it("exposes one bounded MCP tool and rejects added authority inputs", async () => {
    const f = await fixture((_req, res) => reply(res, envelope()));
    const server = await createPhoneMemoryClientMcp(f.credentials);
    const client = new Client({ name: "fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    cleanups.push(async () => { await client.close(); await server.close(); });
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual(["jarvis_memory_context"]);
    expect(listed.tools[0]?.inputSchema.additionalProperties).toBe(false);
    const found = await client.callTool({ name: "jarvis_memory_context", arguments: { query: input.query } });
    expect(found.isError).not.toBe(true); expect(f.calls()).toBe(1);
    const bad = await client.callTool({ name: "jarvis_memory_context", arguments: { query: input.query, agent_id: "attacker" } });
    expect(bad.isError).toBe(true); expect(f.calls()).toBe(1);
  });
});
