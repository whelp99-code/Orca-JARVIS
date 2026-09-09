import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb, runDoctor, type CapabilityFact, type CapabilityProbe } from "../../src/index.js";
import { runtimeCapabilityProbe } from "../../src/doctor.js";
import { passiveSecondBrainReadinessProbe } from "../../src/second-brain-readiness.js";
import { tempDb } from "../helpers.js";

const now = new Date("2026-08-18T12:00:00.000Z");
const ids: ReadonlyArray<CapabilityFact["id"]> = ["codex", "claude", "orca_read", "gjc", "live_resume"];
const stages = ["installed", "configured", "protocol_compatible", "operational", "authorized"] as const;

type Observation = Awaited<ReturnType<CapabilityProbe["inspect"]>>;

const healthy = (): Observation => ({
  installed: { ok: true, version: "0.11.8", evidence: "executable_present" },
  configured: { ok: true, evidence: "configuration_present" },
  protocol_compatible: { ok: true, protocol_version: "2024-11-05", evidence: "protocol_compatible" },
  operational: { ok: true, evidence: "runtime_healthy" },
  authorized: { ok: true, evidence: "authority_present" },
});

function probeFor(overrides: Partial<Record<CapabilityFact["id"], Observation>> = {}): CapabilityProbe {
  const fixtures: Record<CapabilityFact["id"], Observation> = {
    codex: healthy(),
    claude: healthy(),
    orca_read: { ...healthy(), installed: { ok: true, version: null, evidence: "adapter_present" } },
    gjc: healthy(),
    live_resume: healthy(),
    ...overrides,
  };
  return { inspect: async id => fixtures[id] };
}

function fact(capabilities: CapabilityFact[], id: CapabilityFact["id"]): CapabilityFact {
  const found = capabilities.find(item => item.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

describe("doctor", () => {
  it("reports a healthy migrated database on the pinned runtime", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    const report = await runDoctor(db, new Date(), runtimeCapabilityProbe(async () => ({ stdout: "", exitCode: 127 })));
    expect(report.ok).toBe(true);
    expect(report.runtime).toMatchObject({ abi: "137" });
    expect(report.database.applied_migrations).toBe(report.database.expected_migrations);
    expect(report.checks.find(check => check.name === "database.quick_check")).toMatchObject({ ok: true, actual: "ok" });
    expect(report.capabilities.schema_version).toBe(1);
    expect(report.capabilities.capabilities.map(item => item.id)).toEqual(ids);
    expect(JSON.stringify(report.capabilities)).not.toContain("probe_not_injected");
    expect(fact(report.capabilities.capabilities, "gjc").stages.operational.ok).toBe(false);
    expect(fact(report.capabilities.capabilities, "live_resume").stages.configured.ok).toBe(false);
    expect(fact(report.capabilities.capabilities, "codex").stages.configured.ok).toBe(false);
    expect(fact(report.capabilities.capabilities, "codex").stages.authorized.ok).toBe(false);
    expect(fact(report.capabilities.capabilities, "claude").stages.configured.ok).toBe(false);
    expect(fact(report.capabilities.capabilities, "claude").stages.authorized.ok).toBe(false);
    db.close();
  });
  it("fails closed before migrations are applied", async () => {
    const db = new AuthorityDb(tempDb());
    const report = await runDoctor(db, new Date());
    expect(report.ok).toBe(false);
    expect(report.checks.find(check => check.name === "database.migration_count")?.ok).toBe(false);
    expect(report.capabilities.schema_version).toBe(1);
    db.close();
  });
  it("distinguishes unsupported history from missing migrations", async () => {
    // Fully migrated DB plus an unknown history entry must fail readiness.
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    db.db.prepare(
      "INSERT INTO schema_migrations(id,checksum,applied_at) VALUES(?,?,?)",
    ).run("999_unknown_history.sql", "0".repeat(64), "2026-08-18T12:00:00.000Z");
    const journalCount = Number(
      (db.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count,
    );

    // When doctor compares required files to the journal
    const report = await runDoctor(
      db,
      now,
      runtimeCapabilityProbe(async () => ({ stdout: "", exitCode: 127 })),
      passiveSecondBrainReadinessProbe(),
    );
    const migrationCheck = report.checks.find(check => check.name === "database.migration_count");

    // Required migrations are present, but unknown history is not supported.
    expect(report.checks.find(check => check.name === "database.migration_checksums"))
      .toMatchObject({ ok: false, actual: "MIGRATION_VERSION_UNSUPPORTED" });
    expect(journalCount).toBeGreaterThan(report.database.expected_migrations);
    expect(migrationCheck).toMatchObject({ ok: true, actual: report.database.expected_migrations });
    expect(migrationCheck?.code).toBeUndefined();
    expect(report.database.applied_migrations).toBe(report.database.expected_migrations);
    db.close();
  });
  it("attaches a schema_version 1 capability matrix from injected probes without writes", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    db.configureGjc("/tmp/gjc", "session-1", true);
    const before = Number((db.db.prepare("SELECT total_changes() AS count").get() as { count: number }).count);
    const report = await runDoctor(db, now, probeFor());
    expect(report.capabilities).toMatchObject({ schema_version: 1, checked_at: "2026-08-18T12:00:00.000Z" });
    expect(report.capabilities.capabilities.map(item => item.id)).toEqual(ids);
    const gjc = fact(report.capabilities.capabilities, "gjc");
    for (const stage of stages) {
      expect(gjc.stages[stage]?.ok).toBe(true);
      expect(gjc.stages[stage]?.evidence.length).toBeGreaterThan(0);
    }
    expect(Number((db.db.prepare("SELECT total_changes() AS count").get() as { count: number }).count)).toBe(before);
    db.close();
  });
  it("parses bounded executable versions from an injected runner and never emits secrets or placeholders", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    db.configureGjc("/tmp/gjc", "session-1", true);
    const before = Number((db.db.prepare("SELECT total_changes() AS count").get() as { count: number }).count);
    const report = await runDoctor(db, now, runtimeCapabilityProbe(async command => {
      if (command === "codex") return { stdout: "codex 0.11.8\n", exitCode: 0 };
      return { stdout: "token=supersecret claude 1.2.3\n", exitCode: 0 };
    }));
    expect(JSON.stringify(report.capabilities)).not.toContain("probe_not_injected");
    expect(JSON.stringify(report.capabilities)).not.toContain("supersecret");
    expect(fact(report.capabilities.capabilities, "codex").stages.installed).toEqual({ ok: true, evidence: "executable_present" });
    expect(fact(report.capabilities.capabilities, "codex").stages.configured).toEqual({ ok: false, evidence: "configuration_unverified" });
    expect(fact(report.capabilities.capabilities, "codex").stages.authorized).toEqual({ ok: false, evidence: "authority_unverified" });
    expect(fact(report.capabilities.capabilities, "claude").stages.installed).toEqual({ ok: true, evidence: "executable_present" });
    expect(fact(report.capabilities.capabilities, "gjc").stages.operational.ok).toBe(true);
    expect(fact(report.capabilities.capabilities, "live_resume").stages.configured.ok).toBe(false);
    expect(Number((db.db.prepare("SELECT total_changes() AS count").get() as { count: number }).count)).toBe(before);
    db.close();
  });
  it("keeps every in-memory number finite or null for an invalid clock with populated runtime rows", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    db.db.prepare(
      "INSERT INTO gjc_runtime_status(id,pid,last_heartbeat_at,last_error_code,updated_at) VALUES(1,123,?,NULL,?)",
    ).run("2026-08-18T11:59:30.000Z", "2026-08-18T11:59:30.000Z");
    db.db.prepare(
      "INSERT INTO gjc_runtime_leases(id,owner,fence,expires_at,heartbeat_at) VALUES(1,'fixture',1,?,?)",
    ).run("2026-08-18T12:01:00.000Z", "2026-08-18T11:59:30.000Z");
    try {
      const report = await runDoctor(
        db,
        new Date(Number.NaN),
        probeFor(),
        passiveSecondBrainReadinessProbe(),
      );
      expect(nonfiniteNumbers(report)).toEqual([]);
      expect(report.checks.find(check => check.name === "runtime.clock")).toMatchObject({
        ok: false, actual: null, code: "SECOND_BRAIN_CLOCK_INVALID",
      });
      expect(report.checks.find(check => check.name === "service.heartbeat_age_ms")).toMatchObject({
        ok: false, actual: null, code: "SECOND_BRAIN_CLOCK_INVALID",
      });
    } finally {
      db.close();
    }
  });

  it("reaps a SIGTERM-ignoring --version helper after doctor capability inspection times out", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-doctor-probe-"));
    const pidFile = join(root, "probe.pid");
    writeFileSync(join(root, "codex"), `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 60_000);
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${root}:${previousPath ?? "/usr/bin:/bin"}`;
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    let pid: number | undefined;
    let cleanupError: unknown;
    try {
      const report = await runDoctor(db, now, runtimeCapabilityProbe());
      expect(fact(report.capabilities.capabilities, "codex").stages.installed).toEqual({ ok: false, evidence: "probe_timeout" });
      expect(existsSync(pidFile)).toBe(true);
      pid = Number(readFileSync(pidFile, "utf8"));
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      const childPid = pid;
      expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/);
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("ESRCH")) cleanupError = error;
        }
      }
      process.env.PATH = previousPath;
      db.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(dirname(db.filename), { recursive: true, force: true });
    }
    if (cleanupError !== undefined) throw cleanupError;
  }, 15_000);
});

function nonfiniteNumbers(value: unknown, path = "$", found: string[] = []): readonly string[] {
  if (typeof value === "number" && !Number.isFinite(value)) found.push(path);
  else if (Array.isArray(value)) {
    value.forEach((item, index) => nonfiniteNumbers(item, `${path}[${String(index)}]`, found));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) nonfiniteNumbers(item, `${path}.${key}`, found);
  }
  return found;
}
