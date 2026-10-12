import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPersonalConnectorRegistry, PersonalConnectorConfigError } from "../../src/personal-connectors.js";
import { Core5CapabilityRegistry } from "../../src/integration/capability-registry.js";
import { MailPersonalConnectorSource, parseMailConnectorConfig } from "../../src/personal-connector-mail-source.js";
import { CONNECTOR_NOW, connectorHarness, connectorSessionRequest } from "../fixtures/personal-connector-sources.js";

const readerKey = "public-fixture-mail-reader-" + "a".repeat(32);
const principalId = "jarvis-mail-summary-reader";
const root = mkdtempSync(join(tmpdir(), "jarvis-mail-read-"));
const readerKeyFile = join(root, "reader-key");
const calls: string[] = [];
let body: unknown;
let status = 200;
let baseUrl: string;
const server = createServer((req, res) => {
  calls.push(`${req.method} ${req.url}`);
  if (req.method !== "GET" || req.url !== "/api/storage/status"
    || req.headers["x-api-key"] !== readerKey || req.headers["x-principal-id"] !== principalId
    || req.headers["x-principal-kind"] !== "service" || req.headers.accept !== "application/json"
    || ["cookie", "authorization", "x-workspace-id"].some(field => Object.hasOwn(req.headers, field))) {
    res.writeHead(403).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", ...(status === 302 ? { location: "/forbidden" } : {}) })
    .end(JSON.stringify(body));
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
  if (existsSync(readerKeyFile)) chmodSync(readerKeyFile, 0o600);
  writeFileSync(readerKeyFile, readerKey, { mode: 0o600 });
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
function mailConfig(reader_key_file = readerKeyFile) {
  return { base_url: baseUrl, reader_key_file, reader_principal_id: principalId };
}
async function inspect(request: unknown = readRequest) {
  const harness = await connectorHarness();
  try {
    const registry = createPersonalConnectorRegistry({
      ...harness.factory_input, mail: mailConfig(),
    });
    return { result: await registry.inspect(request), definition: registry.list().find(item => item.id === "mail") };
  } finally {
    harness.db.close();
    rmSync(dirname(harness.db.filename), { recursive: true, force: true });
  }
}

describe("read-only personal Mail connector", () => {
  it("supports five concurrent connectors with only the four legacy sources owning checkpoints", async () => {
    const harness = await connectorHarness();
    const registry = createPersonalConnectorRegistry({
      ...harness.factory_input, mail: mailConfig(),
    });
    try {
      const results = await Promise.all([
        ...(["second_brain", "orca", "task_timeline", "portfolio"] as const)
          .map(id => registry.inspect(connectorSessionRequest(id))),
        registry.inspect({ ...readRequest, checkpoint_session: { mode: "start", version: 1 } }),
      ]);
      expect(results.map(result => result.state)).toEqual(["ready", "ready", "no_data", "ready", "ready"]);
      const handles = results.slice(0, 4).map(result => result.checkpoint);
      expect(handles.every(handle => handle !== null)).toBe(true);
      expect(new Set(handles).size).toBe(4);
      expect(results[4]).toMatchObject({ checkpoint: null,
        checkpoint_session: { mode: "stateless", handle: null } });
    } finally {
      harness.db.close();
      rmSync(dirname(harness.db.filename), { recursive: true, force: true });
    }
  });
  it.each(["before", "after"])("opens and closes Mail reads 100 times %s filling legacy slots without a registry restart", async order => {
    const harness = await connectorHarness();
    const registry = createPersonalConnectorRegistry({
      ...harness.factory_input, mail: mailConfig(),
    });
    const ids = ["second_brain", "orca", "task_timeline", "portfolio"] as const;
    const handles: string[] = [];
    const openLegacy = async () => {
      for (const id of ids) {
        const result = await registry.inspect(connectorSessionRequest(id));
        if (result.checkpoint === null) throw new Error(`legacy slot refused: ${result.reason}`);
        handles.push(result.checkpoint);
      }
    };
    try {
      if (order === "after") await openLegacy();
      for (let index = 0; index < 100; index += 1) {
        const checkpoint_session = index % 2 === 0 ? { mode: "start", version: 1 }
          : { mode: "continue", version: 1,
            handle: "pcp:1:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002" };
        // Closing the client discards this stateless result; no server handle exists to release.
        const result = await registry.inspect({ ...readRequest, checkpoint_session });
        expect(result).toMatchObject({ state: "ready", checkpoint: null,
          checkpoint_session: { mode: "stateless", handle: null } });
      }
      if (order === "before") await openLegacy();
      for (const [index, id] of ids.entries()) {
        const result = await registry.inspect(connectorSessionRequest(id, handles[index]));
        expect(result.checkpoint).toBe(handles[index]);
        expect(result.checkpoint_session.mode).toBe("explicit");
      }
      expect(calls).toHaveLength(100);
    } finally {
      harness.db.close();
      rmSync(dirname(harness.db.filename), { recursive: true, force: true });
    }
  });
  it("rejects malformed Mail checkpoint payloads before reading the producer", async () => {
    await expect(inspect({ ...readRequest, checkpoint_session: { mode: "continue", version: 1, handle: "bad" } }))
      .rejects.toMatchObject({ code: "PERSONAL_CONNECTOR_REQUEST_INVALID" });
    expect(calls).toEqual([]);
  });
  it("reads authenticated storage metadata through the registry without projecting mail or secrets", async () => {
    // Given: a private fixture reader key and a service-only HTTP producer.
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
  it.each([401, 403, 302])("does not retry follow redirects or turn refusal %i into empty data", async refusal => {
    status = refusal;
    expect((await inspect({ ...readRequest, checkpoint_session: { mode: "start", version: 1 } })).result)
      .toMatchObject({ state: "unavailable", reason: "adapter_failed", values: {}, checkpoint: null,
        checkpoint_session: { mode: "stateless", handle: null } });
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
  it.each([0o644, 0o400])("refuses reader key file permissions %i before transport", async mode => {
    chmodSync(readerKeyFile, mode);
    expect((await inspect()).result).toMatchObject({ reason: "adapter_failed", values: {} });
    expect(calls).toEqual([]);
  });
  it("refuses missing or symlinked reader key files before transport", async () => {
    await expect(new MailPersonalConnectorSource(mailConfig(join(root, "missing"))).read(CONNECTOR_NOW))
      .rejects.toThrow("CANDIDATE_READER_CREDENTIAL_INVALID");
    const link = join(root, "link");
    symlinkSync(readerKeyFile, link);
    await expect(new MailPersonalConnectorSource(mailConfig(link)).read(CONNECTOR_NOW))
      .rejects.toThrow("CANDIDATE_READER_CREDENTIAL_INVALID");
    expect(calls).toEqual([]);
  });
  it("reports a missing configured key as unavailable", async () => {
    rmSync(readerKeyFile);
    expect((await inspect()).result).toMatchObject({ state: "unavailable", reason: "adapter_failed", values: {} });
    expect(calls).toEqual([]);
  });
  it.each(["", "short", "a".repeat(32) + "\ninside", "a".repeat(4097), " ".repeat(4098) + readerKey])(
    "refuses empty malformed or oversized reader keys case %# before HTTP", async key => {
      writeFileSync(readerKeyFile, key, { mode: 0o600 });
      expect((await inspect()).result).toMatchObject({ state: "unavailable", reason: "adapter_failed", values: {} });
      expect(calls).toEqual([]);
    },
  );
  it("rejects legacy session configuration rather than falling back to a cookie", async () => {
    const harness = await connectorHarness();
    try {
      expect(() => createPersonalConnectorRegistry({
        ...harness.factory_input, mail: { base_url: baseUrl, session_file: readerKeyFile },
      })).toThrow(PersonalConnectorConfigError);
    } finally {
      harness.db.close();
      rmSync(dirname(harness.db.filename), { recursive: true, force: true });
    }
    expect(calls).toEqual([]);
  });
  it.each(["https://foreign.invalid", "http://localhost:3010", "http://127.0.0.1:3010/send",
    "http://127.0.0.1:3010?override=1", "http://user:secret@127.0.0.1:3010"])("rejects non-loopback-root targets %s", base_url => {
    expect(() => parseMailConnectorConfig({ ...mailConfig(), base_url })).toThrow("MAIL_READ_CONFIG_INVALID");
  });
});
