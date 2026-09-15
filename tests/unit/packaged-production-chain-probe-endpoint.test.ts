import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHIPPED_PROBE_AT, SHIPPED_PROBE_MEMORY_AT, probeInstants, probeProviderEndpoint,
  providerlessEnvironment } from "../../scripts/lib/production-chain-probe-endpoint.mjs";

const PROBE = "scripts/packaged-production-chain-probe.mjs";

describe("packaged production chain probe endpoint selection", () => {
  it("defaults to the development-checkout fixture child", () => {
    expect(probeProviderEndpoint({})).toEqual({ kind: "development_checkout_fixture_child" });
  });
  it("reads an installed provider from the two launcher variables", () => {
    expect(probeProviderEndpoint({ JARVIS_SECOND_BRAIN_LAUNCHER: "/install/bin/second-brain-mcp",
      JARVIS_SECOND_BRAIN_CONFIG: "/install/config.toml" })).toEqual({
      kind: "installed_release", launcher: "/install/bin/second-brain-mcp", config: "/install/config.toml" });
  });
  it.each([
    ["launcher only", { JARVIS_SECOND_BRAIN_LAUNCHER: "/install/bin/second-brain-mcp" }],
    ["config only", { JARVIS_SECOND_BRAIN_CONFIG: "/install/config.toml" }],
    ["empty values", { JARVIS_SECOND_BRAIN_LAUNCHER: "", JARVIS_SECOND_BRAIN_CONFIG: "" }],
  ])("keeps the fixture child when the endpoint is incomplete (%s)", (_name, environment) => {
    expect(probeProviderEndpoint(environment)).toEqual({ kind: "development_checkout_fixture_child" });
  });
  it("keeps the providerless arm providerless even when the shell exported an endpoint", () => {
    const environment = providerlessEnvironment({ PATH: "/usr/bin",
      JARVIS_SECOND_BRAIN_LAUNCHER: "/install/bin/second-brain-mcp",
      JARVIS_SECOND_BRAIN_CONFIG: "/install/config.toml" });
    expect(environment).toEqual({ PATH: "/usr/bin" });
    expect(probeProviderEndpoint(environment)).toEqual({ kind: "development_checkout_fixture_child" });
  });
});

describe("packaged production chain probe instants", () => {
  it("keeps the shipped frozen instants when nothing is injected", () => {
    const instants = probeInstants({});
    expect(instants).toMatchObject({ AT: SHIPPED_PROBE_AT, CLI_AT: "2026-08-28T22:15:00.005Z",
      MEMORY_AT: SHIPPED_PROBE_MEMORY_AT, shift_ms: 0 });
  });
  it("shifts every harness instant by the same delta as the injected morning instant", () => {
    const instants = probeInstants({ PROBE_AT: "2026-09-15T13:00:00.000Z" });
    const delta = Date.parse("2026-09-15T13:00:00.000Z") - Date.parse(SHIPPED_PROBE_AT);
    expect(instants.shift_ms).toBe(delta);
    expect(instants.CLI_AT).toBe("2026-09-15T13:00:00.005Z");
    expect(instants.MEMORY_AT).toBe(new Date(Date.parse(SHIPPED_PROBE_MEMORY_AT) + delta).toISOString());
    for (const value of ["2026-08-28T11:00:00.000Z", "2026-08-28T13:00:00.000Z", "2026-08-29T12:00:00.000Z"]) {
      expect(Date.parse(instants.shifted(value)) - Date.parse(value)).toBe(delta);
    }
    expect(instants.shift(-60_000)).toBe("2026-09-15T12:59:00.000Z");
  });
  it("overrides the memory instant on its own", () => {
    expect(probeInstants({ PROBE_MEMORY_AT: "2026-08-28T10:00:00.000Z" }).MEMORY_AT)
      .toBe("2026-08-28T10:00:00.000Z");
  });
  it("refuses an instant that is not a canonical ISO timestamp", () => {
    expect(() => probeInstants({ PROBE_AT: "2026-09-15T13:00:00Z" })).toThrow("PROBE_INSTANT_INVALID");
  });
});

describe("the shipped probe script", () => {
  const source = readFileSync(PROBE, "utf8");
  it("selects its endpoint and instants through the shared module", () => {
    expect(source).toContain("production-chain-probe-endpoint.mjs");
    expect(source).toContain("provider_endpoint");
  });
  it("no longer hard-codes the frozen instants or generates an endpoint inline", () => {
    expect(source).not.toContain(`const AT = "${SHIPPED_PROBE_AT}"`);
    expect(source).not.toContain(`const MEMORY_AT = "${SHIPPED_PROBE_MEMORY_AT}"`);
  });
  it("documents the environment it honours in its header", () => {
    const header = source.slice(0, source.indexOf("import "));
    for (const name of ["JARVIS_SECOND_BRAIN_LAUNCHER", "JARVIS_SECOND_BRAIN_CONFIG", "PROBE_AT"]) {
      expect(header).toContain(name);
    }
  });
});
