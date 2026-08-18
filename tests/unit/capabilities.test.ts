import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { buildCapabilityMatrix, type CapabilityFact, type CapabilityProbe, type CapabilityStage } from "../../src/capabilities.js";
import { tempDb } from "../helpers.js";

const now = new Date("2026-08-18T12:00:00.000Z");
const stages: readonly CapabilityStage[] = ["installed", "configured", "protocol_compatible", "operational", "authorized"];
const ids: ReadonlyArray<CapabilityFact["id"]> = ["codex", "claude", "orca_read", "gjc", "live_resume"];

type Observation = Awaited<ReturnType<CapabilityProbe["inspect"]>>;

const healthy = (): Observation => ({
  installed: { ok: true, version: "0.11.8", evidence: "executable_present" },
  configured: { ok: true, evidence: "configuration_present" },
  protocol_compatible: { ok: true, protocol_version: "2024-11-05", evidence: "protocol_compatible" },
  operational: { ok: true, evidence: "runtime_healthy" },
  authorized: { ok: true, evidence: "authority_present" },
});

function probeFor(overrides: Partial<Record<CapabilityFact["id"], Observation>> = {}, inspectImpl?: CapabilityProbe["inspect"]): CapabilityProbe {
  const fixtures: Record<CapabilityFact["id"], Observation> = {
    codex: healthy(),
    claude: healthy(),
    orca_read: { ...healthy(), installed: { ok: true, version: null, evidence: "adapter_present" } },
    gjc: healthy(),
    live_resume: healthy(),
    ...overrides,
  };
  return { inspect: inspectImpl ?? (async id => fixtures[id]) };
}

async function opened() {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  return db;
}

function fact(matrix: { capabilities: CapabilityFact[] }, id: CapabilityFact["id"]): CapabilityFact {
  const found = matrix.capabilities.find(item => item.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

function later(stage: CapabilityStage): CapabilityStage[] {
  return stages.slice(stages.indexOf(stage) + 1);
}

describe("capability matrix", () => {
  it("reports healthy GJC stages from injected probes and operational DB state without writes", async () => {
    const db = await opened();
    db.configureGjc("/tmp/gjc", "session-1", true);
    const before = Number((db.db.prepare("SELECT total_changes() AS count").get() as { count: number }).count);
    const matrix = await buildCapabilityMatrix(db, probeFor(), now);
    expect(matrix).toMatchObject({ schema_version: 1, checked_at: "2026-08-18T12:00:00.000Z" });
    expect(matrix.capabilities.map(item => item.id)).toEqual(ids);
    const gjc = fact(matrix, "gjc");
    for (const stage of stages) {
      expect(gjc.stages[stage]?.ok).toBe(true);
      expect(gjc.stages[stage]?.evidence.length).toBeGreaterThan(0);
    }
    expect(Number((db.db.prepare("SELECT total_changes() AS count").get() as { count: number }).count)).toBe(before);
    db.close();
  });

  it("keeps later stages false after a missing executable or incompatible protocol", async () => {
    const db = await opened();
    const missing = await buildCapabilityMatrix(db, probeFor({
      codex: { ...healthy(), installed: { ok: false, version: null, evidence: "missing_executable" }, operational: { ok: true, evidence: "runtime_healthy" }, authorized: { ok: true, evidence: "authority_present" } },
    }), now);
    const codex = fact(missing, "codex");
    expect(codex.stages.installed).toMatchObject({ ok: false, evidence: "missing_executable" });
    for (const stage of later("installed")) expect(codex.stages[stage]?.ok).toBe(false);
    expect(JSON.stringify(codex)).not.toMatch(/token|password|authorization\s*[:=]/i);

    const incompatible = await buildCapabilityMatrix(db, probeFor({
      gjc: { ...healthy(), protocol_compatible: { ok: true, protocol_version: "1999-01-01", evidence: "probe_claimed_compatible" } },
    }), now);
    const gjc = fact(incompatible, "gjc");
    expect(gjc.stages.installed.ok).toBe(true);
    expect(gjc.stages.configured.ok).toBe(true);
    expect(gjc.stages.protocol_compatible).toEqual({ ok: false, evidence: "incompatible_protocol" });
    for (const stage of later("protocol_compatible")) expect(gjc.stages[stage]?.ok).toBe(false);
    db.close();
  });

  it("parses versions and protocols before true stages and redacts secret-bearing evidence", async () => {
    const db = await opened();
    db.configureGjc("/tmp/gjc", "session-1", true);
    const unparsed = await buildCapabilityMatrix(db, probeFor({
      claude: { ...healthy(), installed: { ok: true, version: "latest", evidence: "claimed_installed" } },
      gjc: { ...healthy(), protocol_compatible: { ok: true, protocol_version: "not-a-protocol", evidence: "claimed_compatible" } },
    }), now);
    expect(fact(unparsed, "claude").stages.installed).toEqual({ ok: false, evidence: "version_unparsed" });
    for (const stage of later("installed")) expect(fact(unparsed, "claude").stages[stage]?.ok).toBe(false);
    expect(fact(unparsed, "gjc").stages.protocol_compatible).toEqual({ ok: false, evidence: "protocol_version_unparsed" });
    for (const stage of later("protocol_compatible")) expect(fact(unparsed, "gjc").stages[stage]?.ok).toBe(false);

    const credentialEvidence = [
      "token=supersecret authorization=Bearer abc",
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnop",
      "api_key: sk-ant-api03-abcdefghijklmnop",
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "Cookie: session=abcdefghijklmnop",
      "-----BEGIN PRIVATE KEY----- abc -----END PRIVATE KEY-----",
      "glpat-0123456789abcdefghij",
      "npm_0123456789abcdefghij",
      "unregistered arbitrary probe prose",
    ];
    for (const [index, evidence] of credentialEvidence.entries()) {
      const secret = await buildCapabilityMatrix(db, probeFor({
        orca_read: { ...healthy(), configured: { ok: false, evidence } },
      }), now);
      expect(JSON.stringify(secret)).not.toContain(evidence);
      expect(fact(secret, "orca_read").stages.configured.evidence, `case ${index}`).toBe("redacted_probe_failure");
    }
    const secret = await buildCapabilityMatrix(db, probeFor({
      orca_read: { ...healthy(), configured: { ok: false, evidence: credentialEvidence[0]! } },
    }), now);
    expect(Buffer.byteLength(fact(secret, "orca_read").stages.configured.evidence, "utf8")).toBeLessThanOrEqual(512);

    const oversized = await buildCapabilityMatrix(db, probeFor({
      live_resume: { ...healthy(), authorized: { ok: true, evidence: "x".repeat(600) } },
    }), now);
    expect(fact(oversized, "live_resume").stages.configured).toEqual({ ok: false, evidence: "live_resume_not_configured" });
    expect(fact(oversized, "live_resume").stages.operational.ok).toBe(false);
    expect(fact(oversized, "live_resume").stages.authorized.evidence).toBe("redacted_probe_failure");
    db.close();
  });

  it("replaces probe-positive evidence when local authority forces a false stage", async () => {
    const db = await opened();
    const matrix = await buildCapabilityMatrix(db, probeFor(), now);
    expect(fact(matrix, "gjc").stages.operational).toEqual({ ok: false, evidence: "gjc_not_operational" });
    expect(fact(matrix, "live_resume").stages.configured).toEqual({ ok: false, evidence: "live_resume_not_configured" });
    for (const stage of later("operational")) expect(fact(matrix, "gjc").stages[stage]?.ok).toBe(false);
    for (const stage of later("configured")) expect(fact(matrix, "live_resume").stages[stage]?.ok).toBe(false);
    db.close();
  });

  it("turns probe failures into false states and rejects structurally invalid observations", async () => {
    const db = await opened();
    const failed = await buildCapabilityMatrix(db, probeFor({}, async id => {
      if (id === "codex") throw new Error("token=leaked-probe-secret");
      return healthy();
    }), now);
    const codex = fact(failed, "codex");
    for (const stage of stages) expect(codex.stages[stage]?.ok).toBe(false);
    expect(JSON.stringify(codex)).not.toContain("leaked-probe-secret");

    const extra = { ...healthy(), extra: true };
    await expect(buildCapabilityMatrix(db, probeFor({ claude: extra as Observation }), now)).rejects.toMatchObject({ code: "CAPABILITY_INPUT_INVALID" });
    await expect(buildCapabilityMatrix(db, probeFor({ claude: { ...healthy(), installed: { ok: true, version: "0.11.8", evidence: "" } } }), now)).rejects.toMatchObject({ code: "CAPABILITY_INPUT_INVALID" });
    db.close();
  });
});
