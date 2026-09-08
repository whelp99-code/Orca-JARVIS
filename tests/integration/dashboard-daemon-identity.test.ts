import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { GjcRuntimeService } from "../../src/service.js";
import { GjcCoordinatorClient } from "../../src/gjc.js";
import { captureDaemonRuntimeIdentity } from "../../src/daemon-runtime-identity.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { DashboardReadModel } from "../../src/dashboard/read-model.js";
import type { OverviewResponse } from "../../src/dashboard/read-model.js";
import type { SecondBrainReadinessProbe } from "../../src/second-brain-readiness.js";
import { tempDb } from "../helpers.js";

const changes = (db: AuthorityDb) => db.db.prepare("SELECT total_changes() AS n").get();
const secondBrainProbe: SecondBrainReadinessProbe = { inspect: async () => ({
  executable: "missing", configuration: "missing", contract_digest: null, protocol_version: null,
  tools: null, schemas_compatible: false, status: "unavailable", doctor: "unavailable", handshake: "unavailable",
  read_authorization: "unauthorized", write_authorization: "disabled", data_state: "unavailable", refresh: { kind: "missing" },
}) };
describe("dashboard daemon observation", () => {
  it.skipIf(process.platform !== "linux")("reads persisted daemon status separately from server identity through HTTP without writes", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    const snapshot = captureDaemonRuntimeIdentity();
    const service = new GjcRuntimeService(db, new GjcCoordinatorClient(async () => { throw new Error("unexpected"); }),
      "dashboard-identity", undefined, () => new Date(), () => ({ ...snapshot, build: { ...snapshot.build, source_head: "b".repeat(40) } }));
    const server = createDashboardServer({ db, staticRoot: dirname(db.filename), host: "127.0.0.1", port: 0, secondBrainProbe });
    const read = async () => {
      const before = changes(db);
      const response = await request(`http://127.0.0.1:${server.address.port}/api/v1/overview`);
      expect(response.statusCode).toBe(200);
      const body = await response.body.json() as OverviewResponse;
      expect(changes(db)).toEqual(before); return body;
    };
    try {
      expect((await read()).daemon_identity).toMatchObject({ status: "unknown", reason: "missing", snapshot: null });
      await service.once();
      const active = await read();
      expect(active.daemon_identity).toMatchObject({ status: "active", snapshot: { build: { source_head: "b".repeat(40) } } });
      expect(active.runtime!.build.source_head).toBeNull();
      service.close();
      expect((await read()).daemon_identity).toMatchObject({ status: "inactive", reason: "lease_expired" });
      db.claimGjcRuntimeLease("replacement", new Date().toISOString());
      expect((await read()).daemon_identity).toMatchObject({ status: "stale", reason: "lease_changed" });
      db.db.prepare("UPDATE gjc_runtime_identity SET snapshot_json=?").run('{"PRIVATE_MARKER":true}');
      const invalid = await read();
      expect(invalid.daemon_identity).toMatchObject({ status: "unknown", reason: "invalid", snapshot: null });
      expect(JSON.stringify(invalid.daemon_identity)).not.toContain("PRIVATE_MARKER");
      db.db.exec("DROP TABLE gjc_runtime_identity");
      expect((await read()).daemon_identity).toMatchObject({ status: "unknown", reason: "unavailable" });
    } finally { service.close(); server.close(); db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); }
  });
  it("returns unknown for an invalid overview clock without publishing a snapshot", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const before = changes(db);
      expect((await new DashboardReadModel(db, secondBrainProbe).overview(new Date(NaN))).daemon_identity)
        .toMatchObject({ status: "unknown", reason: "clock_invalid", observed_at: null, snapshot: null });
      expect(changes(db)).toEqual(before);
    } finally { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); }
  });
});
