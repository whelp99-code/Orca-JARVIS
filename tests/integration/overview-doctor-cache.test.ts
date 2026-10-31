import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { presentCachedSecondBrain } from "../../src/dashboard/doctor-cache.js";
import { AuthorityDb } from "../../src/index.js";
import {
  evaluateSecondBrainReadiness,
  SECOND_BRAIN_FROZEN_DIGEST,
  SECOND_BRAIN_REQUIRED_TOOLS,
  type SecondBrainReadinessObservation,
} from "../../src/second-brain-readiness.js";
import { SECOND_BRAIN_PROTOCOL_VERSION } from "../../src/second-brain-transport.js";
import { tempDb } from "../helpers.js";

const NOW = new Date("2026-08-28T12:00:00.000Z");

function observation(patch: Partial<SecondBrainReadinessObservation> = {}): SecondBrainReadinessObservation {
  return {
    executable: "available",
    configuration: "valid",
    contract_digest: SECOND_BRAIN_FROZEN_DIGEST,
    protocol_version: SECOND_BRAIN_PROTOCOL_VERSION,
    tools: SECOND_BRAIN_REQUIRED_TOOLS,
    schemas_compatible: true,
    status: "ok",
    doctor: "ok",
    handshake: "ok",
    status_operational: true,
    doctor_operational: true,
    read_authorization: "authorized",
    write_authorization: "authorized",
    data_state: "ready",
    refresh: { kind: "success", completed_at: NOW.toISOString() },
    ...patch,
  };
}

describe("overview doctor cache", () => {
  it("does not return a stale cache as ready and keeps an integrity rejection", () => {
    const fresh = evaluateSecondBrainReadiness(observation(), NOW);
    expect(fresh.readiness).toBe("ready");
    const stale = presentCachedSecondBrain(fresh, new Date(NOW.getTime() + 121_000));
    expect(stale.readiness).not.toBe("ready");
    expect(stale.checked_at).toBe(fresh.checked_at);
    if (stale.readiness === "checking" || stale.checked_at === null) throw new Error("expected a cached report");
    expect(stale.stages.freshness.state).toBe("stale");

    const rejected = evaluateSecondBrainReadiness(observation({ contract_digest: "a".repeat(64) }), NOW);
    if (rejected.readiness === "checking" || rejected.checked_at === null) throw new Error("expected a rejected report");
    expect(rejected.stages.protocol_compatible.reason).toBe("digest_mismatch");
    const aged = presentCachedSecondBrain(rejected, new Date(NOW.getTime() + 121_000));
    if (aged.readiness === "checking" || aged.checked_at === null) throw new Error("expected an aged report");
    expect(aged.readiness).not.toBe("ready");
    expect(aged.stages.protocol_compatible.reason).toBe("digest_mismatch");
    expect(aged.stages.freshness.state).toBe("stale");
  });

  it("answers twenty overview reads from a dev server without waiting for a slow doctor", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const root = mkdtempSync(join(tmpdir(), "overview-cache-measure-"));
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const server = createDashboardServer({
      db,
      staticRoot: root,
      host: "127.0.0.1",
      port: 0,
      clock: () => NOW,
      secondBrainProbe: { inspect: () => pending.then(() => observation()) },
    });
    const origin = `http://${server.address.host}:${String(server.address.port)}`;
    const samples: number[] = [];
    try {
      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        const response = await request(`${origin}/api/v1/overview`);
        const body = await response.body.json() as { second_brain?: { readiness?: string } };
        samples.push(performance.now() - started);
        expect(response.statusCode).toBe(200);
        expect(body.second_brain?.readiness).toBe("checking");
      }
      const sorted = [...samples].sort((left, right) => left - right);
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? sorted.at(-1) ?? 0;
      expect(p95).toBeLessThan(1_000);
      writeFileSync("/home/jm/.gajaegun/gajaeway/workspace/plans/read-check/overview-cache-dev-measure.json", JSON.stringify({
        checked_at: new Date().toISOString(),
        base: "1ec9a51ac2721efba3cb4c896c92deb845ff668c",
        target: origin,
        samples_ms: samples.map(value => Number(value.toFixed(1))),
        p95_ms: Number(p95.toFixed(1)),
        max_ms: Number((sorted.at(-1) ?? 0).toFixed(1)),
        production_switched: false,
      }, null, 2));
    } finally {
      release();
      server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
