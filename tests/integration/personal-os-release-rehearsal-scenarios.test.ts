import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPersonalOsRehearsal } from "../../src/personal-os-rehearsal.js";
import { personalOsScratch, removeScratch } from "../fixtures/personal-os-scratch.js";

const FIXTURE = join(process.cwd(), "test/fixtures/personal-os/full-loop.json");
const CLOCK = "2026-08-27T07:15:00+09:00";
const scratchRoots: string[] = [];
afterEach(() => { for (const root of scratchRoots.splice(0)) removeScratch(root); });

async function scenario(name: string) {
  const releaseRoot = personalOsScratch("jarvis-task36-scenario-");
  scratchRoots.push(releaseRoot);
  const result = await runPersonalOsRehearsal({ fixturePath: FIXTURE, clock: CLOCK, releaseRoot, scenario: name });
  if (result.rehearsal !== "PERSONAL_OS_REHEARSAL_SCENARIO_OK") throw new Error(JSON.stringify(result));
  expect(result.ok).toBe(true);
  expect(result.events.unauthorized).toBe(0);
  expect(result.events.duplicate).toBe(0);
  expect(result.events.stale_authoritative).toBe(0);
  expect(result.events.deletion_leak).toBe(0);
  expect(result.live_path_mutation).toBe(false);
  return result;
}

describe("personal-OS rehearsal scenarios", () => {
  it("reports jm-server offline as unavailable without a live host", async () => {
    const result = await scenario("jm-server-offline");
    expect(result.outcome).toBe("unavailable");
    expect(result.unavailable).toMatchObject({ capability: "jm_server", state: "unavailable" });
  });

  it("leaves a claimed command uncompleted when the worker crashes after dispatch", async () => {
    const result = await scenario("crash-after-dispatch");
    expect(result.outcome).toBe("claimed");
  });

  it("settles a lost memory response as uncertain instead of success", async () => {
    const result = await scenario("lost-memory-response");
    expect(result.outcome).toBe("uncertain");
  });

  it("fails closed on an expired passkey and mints no receipt", async () => {
    const result = await scenario("expired-passkey");
    expect(result.outcome).toBe("fail-closed");
    expect(result.unavailable).toMatchObject({ capability: "remote_approval" });
  });

  it("completes the fixture loop while the Mac client is disconnected", async () => {
    const result = await scenario("mac-disconnected");
    expect(result.outcome).toBe("loop-without-mac");
  });

  it("handshakes an empty provider vault as no_data", async () => {
    const result = await scenario("second-brain-no-data");
    expect(result.outcome).toBe("no_data");
  });

  it("marks second brain unavailable when the launcher is missing", async () => {
    const result = await scenario("second-brain-offline");
    expect(result.outcome).toBe("unavailable");
    expect(result.unavailable).toMatchObject({ capability: "second_brain", state: "unavailable" });
  });

  it("proves the forgotten sentinel is absent after provider tombstone replay", async () => {
    const result = await scenario("restore-tombstone");
    expect(result.outcome).toBe("tombstone-replayed-before-activation");
    expect(result.events.deletion_leak).toBe(0);
  });

  it("proves a delete sentinel stays absent", async () => {
    const result = await scenario("delete-sentinel");
    expect(result.outcome).toBe("sentinel-absent");
    expect(result.events.deletion_leak).toBe(0);
  });
});
