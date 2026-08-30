#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AuthorityDb } from "../dist/src/db.js";
import { TerminalWorkMemory } from "../dist/src/terminal-work-memory.js";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-runtime-smoke-"));
const dbPath = join(temp, "jarvis.sqlite");
const providerBin = process.env.SECOND_BRAIN_PROVIDER_BIN
  ?? join(root, "tests/fixtures/provider-mcp-child.mjs");
const providerConfig = process.env.SECOND_BRAIN_PROVIDER_CONFIG
  ?? join(temp, "provider.toml");
const env = {
  ...process.env,
  JARVIS_DB: dbPath,
  SECOND_BRAIN_PROVIDER_BIN: providerBin,
  SECOND_BRAIN_PROVIDER_CONFIG: providerConfig,
  PATH: `${process.env.PATH ?? ""}`,
};
const checks = [];

function command(name, args, options = {}) {
  const result = spawnSync(name, args, {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `command failed: ${name} ${args.join(" ")}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result.stdout.trim();
}

function jsonLine(value) {
  const lines = value.split("\n").filter(Boolean);
  if (lines.length !== 1) throw new Error("expected one JSON line");
  return JSON.parse(lines[0]);
}

function record(name, detail) {
  checks.push({ name, ok: true, detail });
}

try {
  const migrated = jsonLine(command(process.execPath, [
    "dist/src/cli.js",
    "db",
    "migrate",
    "--db",
    dbPath,
  ]));
  if (migrated.ok !== true) throw new Error("migration smoke failed");
  record("migration", migrated.command);

  const mcpFrames = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ].map((item) => JSON.stringify(item)).join("\n") + "\n";
  const mcp = command(process.execPath, ["scripts/jarvis-agent-mcp.mjs"], {
    input: mcpFrames,
  }).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const tools = mcp.find((item) => item.id === 2)?.result?.tools;
  if (!Array.isArray(tools) || tools.length !== 9) throw new Error("agent MCP smoke failed");
  record("agent_mcp", `${tools.length} tools`);

  const provider = jsonLine(command(process.execPath, [
    "scripts/second-brain-provider-smoke.mjs",
  ]));
  if (provider.ok !== true || provider.health?.status !== "ok") {
    throw new Error("provider health smoke failed");
  }
  record("second_brain_provider", provider.health.contract);

  const dailyStatus = jsonLine(command(process.execPath, [
    "scripts/jarvis-daily-control.mjs",
    "status",
  ]));
  if (dailyStatus.schema_version !== 1) throw new Error("daily status smoke failed");
  const dailyRun = jsonLine(command(process.execPath, [
    "scripts/jarvis-daily-control.mjs",
    "once",
  ]));
  if (dailyRun.schema_version !== 1) throw new Error("daily run smoke failed");
  record("daily_control", dailyRun.loop_date);

  const db = new AuthorityDb(dbPath);
  await db.migrate();
  const terminal = new TerminalWorkMemory(db.db);
  terminal.startSession({
    terminal_id: "terminal:smoke",
    terminal_incarnation_id: "incarnation:smoke",
    host_id: "host:pos:linux-control-plane",
    environment_id: "runtime-smoke",
    terminal_provider: "shell",
    started_at: "2026-08-30T00:00:00.000Z",
    primary_project_id: "project:smoke",
    created_by: "runtime-smoke",
    correlation_id: "corr:session:smoke",
  });
  db.close();
  const shellEvent = {
    event_id: "event:smoke",
    terminal_id: "terminal:smoke",
    terminal_incarnation_id: "incarnation:smoke",
    sequence: 1,
    kind: "command",
    occurred_at: "2026-08-30T00:01:00.000Z",
    started_at: "2026-08-30T00:01:00.000Z",
    finished_at: "2026-08-30T00:01:01.000Z",
    duration_ms: 1000,
    exit_code: 0,
    outcome: "succeeded",
    command_class: "runtime-smoke",
    command: "printf smoke",
    stdout: "smoke complete",
    stderr: null,
    evidence_ref: "runtime-smoke",
    correlation_id: "corr:event:smoke",
    orca_available: false,
    collector_id: "collector:smoke",
    cwd_digest: `sha256:${"c".repeat(64)}`,
  };
  const shell = jsonLine(command(process.execPath, [
    "scripts/collect-terminal-evidence.mjs",
  ], { input: `${JSON.stringify(shellEvent)}\n` }));
  if (shell.ok !== true || shell.event?.event_id !== "event:smoke") {
    throw new Error("shell fallback smoke failed");
  }
  record("shell_fallback", shell.event.redaction_state);

  const rehearsal = jsonLine(command(process.execPath, [
    "scripts/personal-os-recovery-rehearsal.mjs",
  ]));
  if (rehearsal.ok !== true) throw new Error("recovery rehearsal smoke failed");
  record("recovery_rehearsal", `${rehearsal.checks.length} checks`);

  const report = {
    schema_version: 1,
    smoke: "jarvis-runtime-release",
    ok: checks.every((item) => item.ok),
    provider: providerBin,
    checks,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : "RUNTIME_SMOKE_FAILED"}\n`);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
