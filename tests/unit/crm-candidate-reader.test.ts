import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCrmCandidateReader } from "../../src/integration/crm-candidate-reader.js";

const workspace = "75c2b088-e5aa-5396-9e9e-6dfd77e50048";
const key = "unit-only-candidate-reader-key";
const rows = Array.from({ length: 7 }, (_, index) => ({
  id: `candidate-${index}`, status: "CANDIDATE", confirmed: false,
  freshness: "producer_unverified", createdAt: `2026-10-0${index + 1}T00:00:00.000Z`,
}));
let root: string;
let server: Server;
let origin: string;
let keyPath: string;
let mode = "read";
const calls: string[] = [];
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "crm-candidate-reader-"));
  keyPath = join(root, "reader.key");
  writeFileSync(keyPath, key, { mode: 0o600 });
  server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    if (request.method !== "GET" || request.headers["x-api-key"] !== key
      || request.headers["x-workspace-id"] !== workspace || request.headers["x-principal-id"] !== "unit-reader"
      || request.headers["x-principal-kind"] !== "service") {
      response.writeHead(403).end('{"error":"denied"}');
      return;
    }
    response.setHeader("content-type", "application/json");
    if (mode === "denied") { response.writeHead(403).end('{"subject":"private","error":"denied"}'); return; }
    if (mode === "invalid-json") { response.end("{broken"); return; }
    const workspaceId = mode === "foreign" ? "75c2b088-e5aa-4396-9e9e-6dfd77e50048" : workspace;
    if (request.url?.endsWith("/count")) {
      response.end(JSON.stringify({ workspaceId, count: mode === "changed" ? 8 : mode === "empty" ? 0 : 7 }));
    } else {
      response.end(JSON.stringify({ workspaceId, count: mode === "empty" ? 0 : 7,
        candidates: mode === "empty" ? [] : rows.map(row => mode === "private-field" ? { ...row, subject: "private" } : row) }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test address required");
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => { mode = "read"; calls.length = 0; });
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});
function reader() {
  return createCrmCandidateReader({ base_url: origin, key_file: keyPath, workspace_id: workspace, principal: "unit-reader" });
}
describe("native CRM candidate reader", () => {
  it("uses only bound list/count GET and projects the latest five allowed fields", async () => {
    const value = await reader().read(new AbortController().signal);
    expect(value.candidate_count).toBe(7);
    expect(value.recent.map(row => row.id)).toEqual(["candidate-6", "candidate-5", "candidate-4", "candidate-3", "candidate-2"]);
    expect(calls.sort()).toEqual(["GET /api/cwos/v2/mail-candidates", "GET /api/cwos/v2/mail-candidates/count"]);
    expect(Object.keys(value.recent[0] ?? {}).sort()).toEqual(["confirmed", "createdAt", "freshness", "id", "status"]);
    expect(JSON.stringify(value)).not.toContain(key);
  });
  it("distinguishes an authenticated empty snapshot from missing configuration", async () => {
    mode = "empty";
    await expect(reader().read(new AbortController().signal)).resolves.toMatchObject({
      state: "read", candidate_count: 0, recent: [],
    });
  });
  it.each([
    ["denied", "CRM_CANDIDATE_READ_REFUSED"],
    ["invalid-json", "CRM_CANDIDATE_RESPONSE_INVALID"],
    ["foreign", "CRM_CANDIDATE_SCOPE_DENIED"],
    ["changed", "CRM_CANDIDATE_SNAPSHOT_CHANGED"],
    ["private-field", "CRM_CANDIDATE_RESPONSE_INVALID"],
  ])("refuses %s without leaking or retrying", async (failure, code) => {
    mode = failure;
    await expect(reader().read(new AbortController().signal)).rejects.toMatchObject({ code, message: code });
    expect(calls).toHaveLength(2);
  });
  it("rejects non-loopback origin and unsafe credential modes before any native call", () => {
    expect(() => createCrmCandidateReader({ base_url: "https://foreign.invalid", key_file: keyPath,
      workspace_id: workspace, principal: "unit-reader" })).toThrow("CRM_CANDIDATE_READER_CONFIG_INVALID");
    chmodSync(keyPath, 0o644);
    expect(reader).toThrow("CANDIDATE_READER_CREDENTIAL_INVALID");
    chmodSync(keyPath, 0o600);
    const alias = join(root, "alias.key");
    symlinkSync(keyPath, alias);
    expect(() => createCrmCandidateReader({ base_url: origin, key_file: alias,
      workspace_id: workspace, principal: "unit-reader" })).toThrow("CANDIDATE_READER_CREDENTIAL_INVALID");
    expect(calls).toHaveLength(0);
  });
  it("makes no native request for a cancelled read", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(reader().read(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });
});
