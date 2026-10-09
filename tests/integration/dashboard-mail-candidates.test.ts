import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { createMailCandidatesRuntime } from "../../src/integration/mail-candidates-production.js";
import { migratedTestDatabase } from "../fixtures/migrated-database.js";
import type { AuthorityDb } from "../../src/db.js";

let db: AuthorityDb;
let server: DashboardServer;
let root: string;
let origin: string;
let csrf: string;
const runtime = createMailCandidatesRuntime({});
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jarvis-mail-candidates-http-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>test</title>");
  db = await migratedTestDatabase(join(root, "authority.sqlite"));
  server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0, mailCandidates: runtime });
  origin = `http://127.0.0.1:${server.address.port}`;
  const session = await fetch(origin + "/api/v1/session").then(response => response.json());
  csrf = session.csrf_token;
});
afterAll(async () => {
  server.close();
  runtime.close();
  await server.drain();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
describe("protected Mail candidate route", () => {
  it("reports unconfigured sources as unconnected, not zero or a fixture", async () => {
    const response = await fetch(origin + "/api/v1/mail-candidates", { headers: { "x-jarvis-csrf": csrf } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schema_version: 1, proof_level: "native-read", authority: "none",
      crm: { state: "unconnected", reason: "unconfigured" }, sb: { state: "unconnected", reason: "unconfigured" },
    });
  });
  it.each([
    { headers: new Headers() },
    { headers: new Headers({ origin: "https://foreign.invalid", "x-jarvis-csrf": "unbound" }) },
  ])("requires the existing same-origin local session %#", async input => {
    const response = await fetch(origin + "/api/v1/mail-candidates", input);
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty("crm");
  });
  it("refuses caller scope overrides and writes even with the local session", async () => {
    const override = await fetch(origin + "/api/v1/mail-candidates?workspace_id=foreign",
      { headers: { "x-jarvis-csrf": csrf } });
    const write = await fetch(origin + "/api/v1/mail-candidates", {
      method: "POST", headers: { origin, "x-jarvis-csrf": csrf, "content-type": "application/json" }, body: "{}",
    });
    expect(override.status).toBe(400);
    expect(write.status).toBe(403);
  });
  it("refuses invalid configured sources rather than inventing counts", async () => {
    const invalid = createMailCandidatesRuntime({
      JARVIS_CRM_CANDIDATE_READER_BASE_URL: "https://foreign.invalid",
      JARVIS_SB_COMPANY_CANDIDATE_READER_CLIENT_FILE: "/not/a/credential",
    });
    try {
      expect(await invalid.read()).toMatchObject({
        crm: { state: "unconnected", reason: "refused" }, sb: { state: "unconnected", reason: "refused" },
      });
    } finally { invalid.close(); }
  });
});
