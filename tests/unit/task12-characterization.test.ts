import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";
import { execute } from "../../src/cli.js";
import { AuthorityDb } from "../../src/db.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { request } from "undici";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDb } from "../helpers.js";

const NOW = new Date("2026-08-28T12:00:00.000Z");

describe("Task 12 existing public surfaces", () => {
  it("preserves capability, doctor, CLI, dashboard health, and package contracts before extension", async () => {
    // Given: a migrated authority and deterministic clock.
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const root = mkdtempSync(join(tmpdir(), "task12-characterization-"));
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0, clock: () => NOW });

    try {
      // When: each existing public read surface is exercised.
      const capabilities = await execute(["--db", db.filename, "capabilities", "--json"], { clock: () => NOW });
      const doctor = await execute(["--db", db.filename, "doctor"], { clock: () => NOW });
      const healthResponse = await request(`http://${server.address.host}:${String(server.address.port)}/api/v1/health`);
      const health: unknown = JSON.parse(await healthResponse.body.text());

      // Then: shipped machine keys and versions remain stable.
      expect(capabilities).toMatchObject({ ok: true, supported_targets: ["codex", "claude"], matrix: { schema_version: 1 } });
      expect(doctor).toMatchObject({ command: "doctor", report: { checked_at: NOW.toISOString(), capabilities: { schema_version: 1 } } });
      expect(health).toMatchObject({ schema_version: 1, status: "ok", authority: "ready", generated_at: expect.any(String) });
      expect(typeof publicApi.buildCapabilityMatrix).toBe("function");
      expect(typeof publicApi.runDoctor).toBe("function");
    } finally {
      server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
