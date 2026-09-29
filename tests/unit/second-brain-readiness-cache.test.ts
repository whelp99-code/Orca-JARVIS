import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cachedSecondBrainReadinessProbe } from "../../src/second-brain-readiness-cache.js";
import type { SecondBrainReadinessObservation } from "../../src/second-brain-readiness.js";

const observation = (data_state: SecondBrainReadinessObservation["data_state"]): SecondBrainReadinessObservation => ({
  executable: "available",
  configuration: "valid",
  contract_digest: null,
  protocol_version: null,
  tools: null,
  schemas_compatible: false,
  status: "ok",
  doctor: "ok",
  handshake: "ok",
  read_authorization: "authorized",
  write_authorization: "unauthorized",
  data_state,
  refresh: { kind: "missing" },
});

describe("cached Second Brain readiness", () => {
  it("returns a fresh snapshot without waiting on the next inspect", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const inner = {
      inspect: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve(observation("ready"));
        return new Promise<SecondBrainReadinessObservation>((resolve) => {
          release = () => resolve(observation("unavailable"));
        });
      },
    };
    let now = new Date("2026-09-29T00:00:00.000Z");
    const probe = cachedSecondBrainReadinessProbe(inner, 30_000, () => now);
    await probe.inspect();
    now = new Date("2026-09-29T00:00:31.000Z");
    const started = Date.now();
    const cached = await probe.inspect();
    expect(Date.now() - started).toBeLessThan(50);
    expect(cached.data_state).toBe("ready");
    expect(calls).toBe(2);
    release?.();
  });

  it("keeps the Electron health budget above the measured 6.4s inspect", () => {
    const source = readFileSync(new URL("../../scripts/lib/electron-shell.mjs", import.meta.url), "utf8");
    const match = /ELECTRON_HEALTH_TIMEOUT_MS = (\d+_?\d*)/u.exec(source);
    expect(match).not.toBeNull();
    expect(Number(match?.[1]?.replaceAll("_", ""))).toBeGreaterThanOrEqual(10_000);
  });
});
