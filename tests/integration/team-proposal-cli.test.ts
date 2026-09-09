import { symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { AuthorityDb } from "../../src/db.js";
import * as publicApi from "../../src/index.js";
import { buildCapabilityMatrix, type CapabilityFact, type CapabilityProbe } from "../../src/capabilities.js";
import { planTeamProposal, type TeamProposalRequestV1 } from "../../src/team-proposal.js";
import { tempDb } from "../helpers.js";

const now = new Date("2026-08-18T12:00:00.000Z");
const OVERSIZE = 20 * 1024;
const forbiddenExports = [
  "writeTeamProposal",
  "executeTeamProposal",
  "persistTeamProposal",
  "spawnTeam",
  "TeamProposalExecutor",
  "TeamProposalWriter",
  "approveTeamProposal",
  "recordTeamProposal",
] as const;

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

const completeRequest = (): TeamProposalRequestV1 => ({
  schema_version: 1,
  objective: "Ship a bounded capability-aware planner",
  work_type: "development",
  completion_evidence: ["passing focused vitest", "tsc --noEmit exit 0"],
  answers: [],
  constraints: ["no persistence"],
  requested_capabilities: ["codex"],
});

function writeRequest(database: string, name: string, value: unknown): string {
  const path = join(dirname(database), name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

function tableCounts(db: AuthorityDb): Record<string, number> {
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(table => {
    const count = Number((db.db.prepare(`SELECT COUNT(*) AS count FROM "${table.name.replaceAll('"', '""')}"`).get() as { count: number }).count);
    return [table.name, count];
  }));
}

function totalChanges(db: AuthorityDb): number {
  return Number((db.db.prepare("SELECT total_changes() AS count").get() as { count: number }).count);
}

async function migrated(): Promise<string> {
  const database = tempDb();
  await execute(["db", "migrate", "--db", database]);
  return database;
}

async function helpText(args: string[]): Promise<{ result: Record<string, unknown>; text: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => { lines.push(String(message ?? "")); };
  try {
    return { result: await execute(args), text: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

describe("team proposal CLI", () => {
  it("lists team in help and does not open a proposal path as unknown", async () => {
    const help = await helpText(["--help"]);
    expect(help.result).toEqual({ ok: true, command: "help" });
    expect(help.text).toMatch(/Commands:.*\bteam\b/);

    const database = await migrated();
    const request = writeRequest(database, "needs-input.json", { schema_version: 1, objective: "Clarify the missing planning inputs" });
    const result = await execute(["team", "propose", request, "--db", database], {
      capabilityProbe: probeFor(),
      clock: () => now,
    });
    expect(result.command).toBe("team.propose");
    expect(result.ok).toBe(true);
    expect(result).not.toMatchObject({ code: "UNKNOWN_COMMAND" });
  });

  it("plans a ready proposal, leaves SQLite unchanged, and never calls injected runners", async () => {
    const database = await migrated();
    const request = completeRequest();
    const path = writeRequest(database, "ready.json", request);
    const probe = probeFor();
    const authority = new AuthorityDb(database);
    await authority.assertMigrationsReady();
    const expected = planTeamProposal(request, await buildCapabilityMatrix(authority, probe, now));
    const beforeCounts = tableCounts(authority);
    const beforeChanges = totalChanges(authority);
    let orcaCalls = 0;
    let gjcCalls = 0;
    let resumeCalls = 0;
    const result = await execute(["team", "propose", path, "--db", database], {
      capabilityProbe: probe,
      clock: () => now,
      orcaRunner: async () => { orcaCalls += 1; return "{}"; },
      gjcRunner: async () => { gjcCalls += 1; return { stdout: "", exitCode: 1 }; },
      liveOrcaCommand: () => { resumeCalls += 1; return "{}"; },
    });
    expect(result).toEqual({ ok: true, command: "team.propose", proposal: expected });
    expect(expected.status).toBe("ready");
    expect(tableCounts(authority)).toEqual(beforeCounts);
    expect(totalChanges(authority)).toBe(beforeChanges);
    authority.close();
    const verify = new AuthorityDb(database);
    await verify.assertMigrationsReady();
    expect(tableCounts(verify)).toEqual(beforeCounts);
    expect(totalChanges(verify)).toBe(0);
    verify.close();
    expect({ orcaCalls, gjcCalls, resumeCalls }).toEqual({ orcaCalls: 0, gjcCalls: 0, resumeCalls: 0 });
  });

  it("returns needs_input for an incomplete request without members", async () => {
    const database = await migrated();
    const path = writeRequest(database, "incomplete.json", { schema_version: 1, objective: "Clarify the missing planning inputs" });
    const result = await execute(["team", "propose", path, "--db", database], {
      capabilityProbe: probeFor(),
      clock: () => now,
    });
    expect(result).toMatchObject({ ok: true, command: "team.propose" });
    const proposal = result.proposal as { status: string; questions: Array<{ id: string; required: true }>; members?: unknown };
    expect(proposal.status).toBe("needs_input");
    expect(proposal.questions.length).toBeGreaterThanOrEqual(2);
    expect(proposal.questions.length).toBeLessThanOrEqual(3);
    expect(proposal.questions.every(question => question.required === true)).toBe(true);
    expect(proposal).not.toHaveProperty("members");
  });

  it("returns blocked with capability stage reasons when a requested provider is unavailable", async () => {
    const database = await migrated();
    const path = writeRequest(database, "blocked.json", { ...completeRequest(), requested_capabilities: ["codex", "gjc"] });
    const result = await execute(["team", "propose", path, "--db", database], {
      capabilityProbe: probeFor(),
      clock: () => now,
    });
    expect(result).toEqual({
      ok: true,
      command: "team.propose",
      proposal: {
        schema_version: 1,
        status: "blocked",
        reasons: [{ capability_id: "gjc", stage: "operational" }],
      },
    });
  });

  it("rejects bad JSON, oversized files, and invalid requests through TEAM_PROPOSAL_INPUT_INVALID", async () => {
    const database = await migrated();
    const badJson = writeRequest(database, "bad.json", "{");
    const oversized = writeRequest(database, "oversized.json", "x".repeat(OVERSIZE));
    const invalid = writeRequest(database, "invalid.json", { ...completeRequest(), schema_version: 2 });
    const extra = writeRequest(database, "extra.json", { ...completeRequest(), extra: true });
    await expect(execute(["team", "propose", badJson, "--db", database], { capabilityProbe: probeFor(), clock: () => now })).rejects.toMatchObject({ code: "TEAM_PROPOSAL_INPUT_INVALID" });
    await expect(execute(["team", "propose", oversized, "--db", database], { capabilityProbe: probeFor(), clock: () => now })).rejects.toMatchObject({ code: "TEAM_PROPOSAL_INPUT_INVALID" });
    await expect(execute(["team", "propose", invalid, "--db", database], { capabilityProbe: probeFor(), clock: () => now })).rejects.toMatchObject({ code: "TEAM_PROPOSAL_INPUT_INVALID" });
    await expect(execute(["team", "propose", extra, "--db", database], { capabilityProbe: probeFor(), clock: () => now })).rejects.toMatchObject({ code: "TEAM_PROPOSAL_INPUT_INVALID" });
    await expect(execute(["team", "propose", join(dirname(database), "missing.json"), "--db", database], { capabilityProbe: probeFor(), clock: () => now })).rejects.toMatchObject({ code: "TEAM_PROPOSAL_INPUT_INVALID" });
    await expect(execute(["team", "spawn", badJson, "--db", database], { capabilityProbe: probeFor(), clock: () => now })).rejects.toMatchObject({ code: "UNKNOWN_COMMAND" });
  });

  it("rejects extra positional arguments on team propose", async () => {
    const database = await migrated();
    const request = writeRequest(database, "request.json", completeRequest());
    await expect(execute(["team", "propose", request, "IGNORED_POSITIONAL", "--db", database], { capabilityProbe: probeFor(), clock: () => now })).rejects.toMatchObject({ code: expect.stringMatching(/^(UNKNOWN_COMMAND|TEAM_PROPOSAL_INPUT_INVALID)$/) });
  });

  it("rejects unknown and irrelevant flags on team propose before reading input", async () => {
    const database = await migrated();
    const request = writeRequest(database, "request.json", completeRequest());
    const cases: Array<{ args: string[]; flag: string }> = [
      { args: ["team", "propose", request, "--bogus", "--db", database], flag: "--bogus" },
      { args: ["team", "propose", request, "--bogus=value", "--db", database], flag: "--bogus=value" },
      { args: ["team", "propose", request, "--once", "--db", database], flag: "--once" },
    ];
    for (const { args, flag } of cases) {
      const code = flag.startsWith("--bogus") ? "CLI_ARGUMENT_INVALID"
        : expect.stringMatching(/^(UNKNOWN_COMMAND|TEAM_PROPOSAL_INPUT_INVALID)$/);
      await expect(execute(args, { capabilityProbe: probeFor(), clock: () => now })).rejects.toMatchObject({ code });
      await expect(execute(args, { capabilityProbe: probeFor(), clock: () => now })).rejects.not.toMatchObject({ code: "INTERNAL_ERROR" });
      await expect(execute(args, { capabilityProbe: probeFor(), clock: () => now }).catch(error => error && { rejected: true, flag })).resolves.toEqual({ rejected: true, flag });
    }
  });

  it("rejects symlinks and FIFOs as proposal input without following or blocking", async () => {
    const database = await migrated();
    const regular = writeRequest(database, "regular.json", completeRequest());
    const symlink = join(dirname(database), "request-link.json");
    symlinkSync(regular, symlink);
    await expect(execute(["team", "propose", symlink, "--db", database], { capabilityProbe: probeFor(), clock: () => now })).rejects.toMatchObject({ code: "TEAM_PROPOSAL_INPUT_INVALID" });

    const fifo = join(dirname(database), "request.fifo");
    execFileSync("mkfifo", [fifo]);
    const writer = spawn("sh", ["-c", "printf '%s' \"$REQUEST\" > \"$FIFO\"", "fifo-writer"], { env: { ...process.env, FIFO: fifo, REQUEST: JSON.stringify(completeRequest()) }, stdio: "ignore" });
    const writerExited = new Promise<void>((resolve, reject) => {
      writer.once("error", reject);
      writer.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`FIFO writer exited ${String(code)} ${String(signal)}`)));
    });
    await expect(execute(["team", "propose", fifo, "--db", database], { capabilityProbe: probeFor(), clock: () => now })).rejects.toMatchObject({ code: "TEAM_PROPOSAL_INPUT_INVALID" });
    writer.kill();
    await writerExited.catch(() => undefined);
  });

  it("exports only proposal types and the pure planner from the public API", () => {
    expect(publicApi.planTeamProposal).toEqual(expect.any(Function));
    expect(forbiddenExports.filter(name => name in publicApi)).toEqual([]);
  });
});
