import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import {
  SECOND_BRAIN_FROZEN_DIGEST,
  SECOND_BRAIN_REQUIRED_TOOLS,
  type SecondBrainReadinessProbe,
} from "../../src/second-brain-readiness.js";
import { SECOND_BRAIN_PROTOCOL_VERSION } from "../../src/second-brain-transport.js";
import { execute } from "../../src/cli.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { tempDb } from "../helpers.js";

const NOW = new Date("2026-08-28T12:00:00.000Z");
const probe: SecondBrainReadinessProbe = {
  inspect: async () => ({
    executable: "available", configuration: "valid", contract_digest: SECOND_BRAIN_FROZEN_DIGEST,
    protocol_version: SECOND_BRAIN_PROTOCOL_VERSION, tools: SECOND_BRAIN_REQUIRED_TOOLS, schemas_compatible: true,
    status: "ok", doctor: "ok", handshake: "ok", read_authorization: "authorized",
    write_authorization: "disabled", data_state: "no_data",
    refresh: { kind: "success", completed_at: "2026-08-27T10:00:00.000Z" },
  }),
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("expected record");
  return Object.fromEntries(Object.entries(value));
}

describe("Second Brain readiness projections", () => {
  it("projects one canonical redacted report through CLI, doctor, dashboard health, and overview", async () => {
    // Given: one injected safe probe and one injected clock.
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const root = mkdtempSync(join(tmpdir(), "second-brain-readiness-surfaces-"));
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    const server = createDashboardServer({
      db, staticRoot: root, host: "127.0.0.1", port: 0, clock: () => NOW, secondBrainProbe: probe,
    });
    try {
      // When: every owning surface is exercised through its real API.
      const capabilities = await execute(["--db", db.filename, "capabilities", "--json"], { clock: () => NOW, secondBrainProbe: probe });
      const doctor = await execute(["--db", db.filename, "doctor"], { clock: () => NOW, secondBrainProbe: probe });
      const origin = `http://${server.address.host}:${String(server.address.port)}`;
      const health = record(JSON.parse(await (await request(`${origin}/api/v1/health`)).body.text()));
      const overview = record(JSON.parse(await (await request(`${origin}/api/v1/overview`)).body.text()));

      // Then: all projections are byte-identical and retain staged degradation.
      const expected = record(capabilities.second_brain);
      expect(JSON.stringify(record(record(doctor.report).second_brain))).toBe(JSON.stringify(expected));
      expect(JSON.stringify(record(health.second_brain))).toBe(JSON.stringify(expected));
      expect(JSON.stringify(record(overview.second_brain))).toBe(JSON.stringify(expected));
      expect(record(record(expected.stages).authorized)).toMatchObject({ state: "read_only", reason: "write_disabled" });
      expect(record(record(expected.stages).data_state).state).toBe("no_data");
      expect(record(record(expected.stages).freshness).state).toBe("stale");
      expect(JSON.stringify(expected)).not.toMatch(/\/home\/|credential|token|stdout|stderr|mac/i);
    } finally {
      server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
