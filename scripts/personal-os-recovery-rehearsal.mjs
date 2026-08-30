#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const expected033 = "33e2755a78d87d281bfd3bfe7b18aed07ee3b93216f5131c4453329f169596b4";
const specifications = [
  [
    "terminal-evidence-collector",
    "scripts/collect-terminal-evidence.mjs",
    ["ShellFallbackCollector", "JARVIS_DB", "MAX_FRAME"],
  ],
  [
    "terminal-evidence-policy",
    "dist/src/shell-fallback.js",
    ["orca_available", "keypress", "SHELL_FALLBACK_REDACTION_REQUIRED"],
  ],
  [
    "agent-mcp-stdio",
    "dist/src/agent-mcp-server.js",
    ["2025-11-25", "tools/list", "JARVIS_MCP_MAX_FRAME_BYTES"],
  ],
  [
    "memory-settlement-provider",
    "deploy/jm-jarvis-memory-settlement@.service",
    ["SECOND_BRAIN_PROVIDER_BIN=/home/jm/.local/bin/sb", "ReadWritePaths="],
  ],
  [
    "daily-control-persistence",
    "deploy/jm-jarvis-daily-control.timer",
    ["07:15:00 Asia/Seoul", "21:30:00 Asia/Seoul", "Persistent=true"],
  ],
  [
    "phone-gateway-binding",
    "dist/src/phone-gateway-main.js",
    ["127.0.0.1", "256 * 1024"],
  ],
  [
    "phone-gateway-service-hardening",
    "deploy/jm-jarvis-phone-gateway.service",
    ["NoNewPrivileges=true", "PrivateTmp=true", "IPAddressDeny=any"],
  ],
  [
    "second-brain-refresh",
    "deploy/jm-second-brain-refresh.service",
    ["/home/jm/.local/bin/sb run", "ProtectSystem=strict"],
  ],
  [
    "terminal-memory-forward-migration",
    "migrations/034_terminal_work_memory.sql",
    ["CREATE TABLE terminal_sessions", "CREATE TABLE workflow_correlations"],
  ],
];

const checks = [];
for (const [name, relative, required] of specifications) {
  const text = await readFile(resolve(root, relative), "utf8");
  checks.push({
    name,
    path: relative,
    ok: required.every((token) => text.includes(token)),
    required,
  });
}
const migration033 = await readFile(resolve(root, "migrations/033_personal_operations.sql"));
const observed033 = createHash("sha256").update(migration033).digest("hex");
checks.push({
  name: "immutable-migration-033",
  path: "migrations/033_personal_operations.sql",
  ok: observed033 === expected033,
  expected: expected033,
  observed: observed033,
});
const report = {
  schema_version: 1,
  rehearsal: "personal-os-recovery",
  ok: checks.every((result) => result.ok),
  checks,
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.ok) process.exitCode = 1;
