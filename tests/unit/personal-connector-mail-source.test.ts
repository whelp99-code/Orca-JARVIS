import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPersonalConnectorRegistry } from "../../src/personal-connectors.js";
import { Core5CapabilityRegistry } from "../../src/integration/capability-registry.js";
import { MailPersonalConnectorSource, parseMailConnectorConfig } from "../../src/personal-connector-mail-source.js";
import { CONNECTOR_NOW, connectorHarness } from "../fixtures/personal-connector-sources.js";

const token = "a".repeat(43);
const root = mkdtempSync(join(tmpdir(), "jarvis-mail-read-"));
const sessionFile = join(root, "session");
const calls: string[] = [];
let body: unknown;
let status = 200;
let baseUrl: string;
const server = createServer((req, res) => {
  calls.push(`${req.method} ${req.url}`);
  if (req.method !== "GET" || req.url !== "/api/storage/status" || req.headers.cookie !== `mi_session=${token}`) {
    res.writeHead(403).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
});
beforeAll(async () => {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  writeFileSync(sessionFile, token, { mode: 0o600 });
  chmodSync(sessionFile, 0o600);
  calls.length = 0;
  status = 200;
  body = { ready: true, counts: { messages: 7, threads: 3 }, jobs: [{ secret: "must not be projected" }] };
});
afterAll(async () => {
  const closed = once(server, "close");
  server.close();
  await closed;
  rmSync(root, { recursive: true, force: true });
});
const readRequest = {
  connector_id: "mail", scopes: ["mail.summary.read"], fields: ["message_count", "thread_count", "observed_at"],
};
async function inspect(request: unknown = readRequest) {
  const harness = await connectorHarness();
  try {
    const registry = createPersonalConnectorRegistry({
      ...harness.factory_input, mail: { base_url: baseUrl, session_file: sessionFile },
    });
    return { result: await registry.inspect(request), definition: registry.list().find(item => item.id === "mail") };
  } finally {
    harness.db.close();
    rmSync(dirname(harness.db.filename), { recursive: true, force: true });
  }
}

describe("read-only personal Mail connector", () => {
  it("reads authenticated storage metadata through the registry without projecting mail or secrets", async () => {
    // Given: the existing session file and a real HTTP producer.
    // When: the scoped public registry read executes.
    const { result, definition } = await inspect();
    // Then: only summary metadata crosses the connector boundary.
    expect(definition).toMatchObject({ configured: true, capabilities: ["storage_summary"], scopes: ["mail.summary.read"] });
    expect(result).toMatchObject({ state: "ready", reason: "current", freshness: "unknown",
      values: { message_count: 7, thread_count: 3, observed_at: CONNECTOR_NOW.toISOString() } });
    expect(Object.keys(result.values).sort()).toEqual(["message_count", "observed_at", "thread_count"]);
    expect(calls).toEqual(["GET /api/storage/status"]);
    expect(() => new Core5CapabilityRegistry({ CORE5_INTEGRATION_ENABLED: "1" }).get("mail.send"))
      .toThrow(expect.objectContaining({ code: "CORE5_LIVE_SEND_NOT_REGISTERED" }));
  });
  it("projects only the requested subset", async () => {
    const { result } = await inspect({ ...readRequest, fields: ["message_count"] });
    expect(result.values).toEqual({ message_count: 7 });
  });
  it("distinguishes verified empty storage from unavailable storage", async () => {
    body = { ready: true, counts: { messages: 0, threads: 0 } };
    expect((await inspect()).result).toMatchObject({ state: "no_data", reason: "current_empty", values: {} });
    body = { ready: false, counts: { messages: 0, threads: 0 } };
    expect((await inspect()).result).toMatchObject({ state: "unavailable", reason: "source_unavailable", values: {} });
  });
  it.each([
    {}, { ready: true, counts: { messages: "7", threads: 3 } },
    { ready: true, counts: { messages: -1, threads: 3 } },
    { ready: true, counts: { messages: 1.5, threads: 3 } },
  ])("fails closed on malformed producer metadata %#", async invalid => {
    body = invalid;
    expect((await inspect()).result).toMatchObject({ state: "unavailable", reason: "adapter_failed", values: {} });
  });
  it("does not retry or turn refusal into empty data", async () => {
    status = 401;
    expect((await inspect()).result).toMatchObject({ state: "unavailable", reason: "adapter_failed", values: {} });
    expect(calls).toEqual(["GET /api/storage/status"]);
  });
  it.each([
    { scopes: ["mail.send"] }, { scopes: ["mail.summary.read"], fields: ["body"] },
    { scopes: [], fields: ["message_count"] },
  ])("rejects overbroad requests before upstream access %#", async override => {
    await expect(inspect({ ...readRequest, ...override })).rejects.toMatchObject({ code: "PERSONAL_CONNECTOR_REQUEST_INVALID" });
    expect(calls).toEqual([]);
  });
  it("skips upstream for empty scopes and for unconfigured mail", async () => {
    expect((await inspect({ ...readRequest, scopes: [], fields: [] })).result).toMatchObject({ reason: "no_scope" });
    const harness = await connectorHarness();
    try {
      expect(harness.registry.list().find(item => item.id === "mail")?.configured).toBe(false);
      expect(await harness.registry.inspect({ connector_id: "mail", scopes: [], fields: [] }))
        .toMatchObject({ reason: "not_configured" });
    } finally {
      harness.db.close();
      rmSync(dirname(harness.db.filename), { recursive: true, force: true });
    }
    expect(calls).toEqual([]);
  });
  it("refuses exposed or symlinked session files before transport", async () => {
    chmodSync(sessionFile, 0o644);
    expect((await inspect()).result).toMatchObject({ reason: "adapter_failed", values: {} });
    const link = join(root, "link");
    symlinkSync(sessionFile, link);
    await expect(new MailPersonalConnectorSource({ base_url: baseUrl, session_file: link }).read(CONNECTOR_NOW))
      .rejects.toThrow("CANDIDATE_READER_CREDENTIAL_INVALID");
    expect(calls).toEqual([]);
  });
  it.each(["https://foreign.invalid", "http://localhost:3010", "http://127.0.0.1:3010/send",
    "http://127.0.0.1:3010?override=1", "http://user:secret@127.0.0.1:3010"])("rejects non-loopback-root targets %s", base_url => {
    expect(() => parseMailConnectorConfig({ base_url, session_file: sessionFile })).toThrow("MAIL_READ_CONFIG_INVALID");
  });
});
