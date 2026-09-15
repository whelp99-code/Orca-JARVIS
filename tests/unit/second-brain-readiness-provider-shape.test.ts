import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SECOND_BRAIN_FROZEN_DIGEST,
  SECOND_BRAIN_REQUIRED_TOOLS,
  evaluateSecondBrainReadiness,
  type SecondBrainReadinessObservation,
} from "../../src/second-brain-readiness.js";
import { parseSecondBrainDoctorReport } from "../../src/second-brain-readiness-facts.js";
import {
  runtimeSecondBrainReadinessProbe,
  secondBrainProbeArguments,
  type SecondBrainReadinessRunner,
} from "../../src/second-brain-readiness-runtime.js";

/** The exact document `sb doctor --json` prints on the deployed provider release. */
const PROVIDER_DOCTOR = JSON.stringify([
  { name: "python", status: "pass", detail: "Python runtime available; app 1.0.0" },
  { name: "vault", status: "pass", detail: "path=/home/jm/.local/share/second-brain/vault mode=0o500" },
  { name: "ledger", status: "pass", detail: "schema=5/5" },
  { name: "scheduler-assets", status: "warn", detail: "deploy/systemd" },
], null, 2);
const PROVIDER_STATUS = "2026-09-15T20:14:11.462201+09:00 run 262285d94b7d ok pages=1 conflicts=0 errors=0\n";

function runner(overrides: Partial<SecondBrainReadinessRunner> = {}): SecondBrainReadinessRunner {
  return {
    executable: async () => "available",
    configuration: async () => "valid",
    run: async command => ({ kind: "ok", stdout: command === "doctor" ? PROVIDER_DOCTOR : PROVIDER_STATUS }),
    handshake: async () => ({
      kind: "ok", stdout: "",
      facts: {
        protocol_version: "2025-11-25", server_name: "second-brain", server_version: "",
        tools: [...SECOND_BRAIN_REQUIRED_TOOLS], input_schemas_compatible: true,
        output_schemas_compatible: true,
      },
      read: { read: "authorized", contract_digest: SECOND_BRAIN_FROZEN_DIGEST, data_state: "ready" },
    }),
    ...overrides,
  };
}

describe("readiness against the provider release's real surfaces", () => {
  it("freezes the digest the shipped contract artifact and the provider both report", () => {
    // Given: the frozen MCP contract this release ships and validates tools/list against.
    const bytes = readFileSync("contracts/second-brain-mcp-v1.json");
    // Then: the frozen constant is that artifact's digest, so the provider's own
    // sb_generation_status contract_digest can be compared against it.
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(SECOND_BRAIN_FROZEN_DIGEST);
    expect(readFileSync("contracts/second-brain-mcp-v1.json.sha256", "ascii")).toBe(`${SECOND_BRAIN_FROZEN_DIGEST}\n`);
  });

  it("asks doctor for the machine-readable document it can parse", () => {
    // Then: the probe requests the provider's JSON doctor report, not its human lines.
    expect(secondBrainProbeArguments("doctor")).toEqual(["doctor", "--json"]);
    expect(secondBrainProbeArguments("status")).toEqual(["status"]);
  });

  it("parses the provider's doctor array and reads failure from check status", () => {
    // Given: the provider's real document, one with a failing check, and the legacy human lines.
    const report = parseSecondBrainDoctorReport(PROVIDER_DOCTOR);
    const failing = parseSecondBrainDoctorReport(JSON.stringify([{ name: "vault", status: "fail", detail: "absent" }]));
    // Then: warnings stay operational, a failure does not, and unparseable text is refused.
    expect(report).toEqual({ operational: true, failed: [] });
    expect(failing).toEqual({ operational: false, failed: ["vault"] });
    expect(parseSecondBrainDoctorReport("PASS python: ok\n")).toBeUndefined();
    expect(parseSecondBrainDoctorReport("")).toBeUndefined();
  });

  it("reports the negotiated protocol, the granted read and the vault state it observed", async () => {
    // When: the runtime probe inspects the provider through its real surfaces.
    const observed = await runtimeSecondBrainReadinessProbe(runner()).inspect();
    // Then: the handshake facts and the read seam reach the observation instead of hardcoded holes.
    expect(observed).toMatchObject({
      contract_digest: SECOND_BRAIN_FROZEN_DIGEST, protocol_version: "2025-11-25",
      doctor: "ok", status: "ok", handshake: "ok",
      status_operational: true, doctor_operational: true,
      read_authorization: "authorized", data_state: "ready",
    });
    expect(observed.tools).toEqual([...SECOND_BRAIN_REQUIRED_TOOLS].sort());
    // And: a successful run whose completion the legacy line cannot prove stays an attempt.
    expect(observed.refresh).toEqual({ kind: "success_attempted", attempted_at: "2026-09-15T11:14:11.462Z" });
    expect(observed.last_successful_refresh_at ?? null).toBeNull();
  });

  it("stages that observation as a compatible, operational, readable provider", async () => {
    // Given: the observation the runtime probe now produces.
    const observation = await runtimeSecondBrainReadinessProbe(runner()).inspect();
    // When: readiness is evaluated.
    const report = evaluateSecondBrainReadiness(observation as SecondBrainReadinessObservation,
      new Date("2026-09-15T11:30:00.000Z"));
    // Then: every stage the dashboard reported blank is now decided, and only the unprobed write
    // and the absent refresh receipt hold readiness at degraded.
    expect(report.stages.protocol_compatible).toMatchObject({ state: "compatible", reason: "compatible" });
    expect(report.stages.operational).toMatchObject({ state: "operational", reason: "probes_succeeded" });
    expect(report.stages.authorized).toMatchObject({ state: "read_only", reason: "write_unauthorized", read: true, write: false });
    expect(report.stages.data_state).toMatchObject({ state: "ready" });
    expect(report.stages.last_successful_refresh).toMatchObject({ state: "missing", observed_at: null, latest_attempt: "success" });
    expect(report.readiness).toBe("degraded");
  });

  it("keeps a refused read unauthorized and a failing doctor unavailable", async () => {
    // Given: a provider that answers the handshake but refuses the read, and one failing doctor.
    const refused = runner({ handshake: async () => ({ kind: "ok", stdout: "",
      facts: { protocol_version: "2025-11-25", server_name: "second-brain", server_version: "",
        tools: [...SECOND_BRAIN_REQUIRED_TOOLS], input_schemas_compatible: true, output_schemas_compatible: true },
      read: { read: "unauthorized", contract_digest: null, data_state: "unknown" } }) });
    const broken = runner({ run: async command => ({ kind: "ok",
      stdout: command === "doctor" ? JSON.stringify([{ name: "vault", status: "fail", detail: "x" }]) : PROVIDER_STATUS }) });
    // When: each is inspected and evaluated.
    const at = new Date("2026-09-15T11:30:00.000Z");
    const refusedReport = evaluateSecondBrainReadiness(await runtimeSecondBrainReadinessProbe(refused).inspect(), at);
    const brokenReport = evaluateSecondBrainReadiness(await runtimeSecondBrainReadinessProbe(broken).inspect(), at);
    // Then: readiness fails closed with the reason each refusal produced.
    expect(refusedReport.stages.authorized).toMatchObject({ state: "unauthorized", reason: "read_unauthorized" });
    expect(brokenReport.stages.operational).toMatchObject({ state: "unavailable", reason: "probe_contradiction" });
  });
});
