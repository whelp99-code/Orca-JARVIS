import { AuthorityDb } from "./db.js";
import {
  DASHBOARD_HEALTH_MAX_BYTES,
  DASHBOARD_HEALTH_TIMEOUT_MS,
  DASHBOARD_HEALTH_URL,
} from "./dashboard-runtime-config.js";
import { runDoctor } from "./doctor.js";
import { type ReleaseGate, type ReleaseGateOptions, type ReleaseGateReport, gate } from "./release-gate-contract.js";
import {
  foreignKeyCheckGate,
  migrationVectorGate,
  quickCheckGate,
  schedulerCursorGate,
  uncertainOutboxGate,
} from "./release-database-gates.js";
import { attestedSecondBrainHandshake } from "./second-brain-readiness-handshake.js";
import {
  SECOND_BRAIN_CONTRACT_PROFILE,
  SECOND_BRAIN_PROTOCOL_VERSION,
  SecondBrainTransportError,
  createSecondBrainTransport,
} from "./second-brain-transport.js";

export {
  RELEASE_GATE_NAMES,
  type ReleaseGate,
  type ReleaseGateName,
  type ReleaseGateOptions,
  type ReleaseGateReport,
} from "./release-gate-contract.js";
export {
  type MigrationEntryObservation,
  foreignKeyCheckGate,
  migrationVectorGate,
  quickCheckGate,
  schedulerCursorGate,
  shippedMigrationEntries,
  uncertainOutboxGate,
} from "./release-database-gates.js";

async function boundedBody(response: Response, maxBytes: number): Promise<string | undefined> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) return undefined;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8");
}

/** A bounded-timeout GET of the configured dashboard health route. Fails closed on any refusal. */
export async function dashboardHealthGate(input: {
  readonly url?: string;
  readonly timeoutMs?: number;
} = {}): Promise<ReleaseGate> {
  const url = input.url ?? DASHBOARD_HEALTH_URL;
  const timeoutMs = input.timeoutMs ?? DASHBOARD_HEALTH_TIMEOUT_MS;
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      return gate("dashboard-health", false, { url, status: response.status },
        "RELEASE_GATE_DASHBOARD_UNHEALTHY");
    }
    const text = await boundedBody(response, DASHBOARD_HEALTH_MAX_BYTES);
    if (text === undefined) {
      return gate("dashboard-health", false, { url, status: 200, body: "oversize" },
        "RELEASE_GATE_DASHBOARD_OVERSIZE");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return gate("dashboard-health", false, { url, status: 200, body: "malformed" },
        "RELEASE_GATE_DASHBOARD_MALFORMED");
    }
    const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
    const status = record?.["status"];
    const authority = record?.["authority"];
    const ok = status === "ok" && authority === "ready";
    return gate("dashboard-health", ok, { url, status: 200, health_status: status ?? null, authority: authority ?? null },
      ok ? undefined : "RELEASE_GATE_DASHBOARD_UNHEALTHY");
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return gate("dashboard-health", false, { url, status: null },
      timeout ? "RELEASE_GATE_DASHBOARD_TIMEOUT" : "RELEASE_GATE_DASHBOARD_UNREACHABLE");
  }
}

/**
 * A real handshake over the Second Brain stdio transport contract. The launcher and config come
 * from JARVIS_SECOND_BRAIN_LAUNCHER/JARVIS_SECOND_BRAIN_CONFIG when set, so an isolated provider
 * can be probed without touching the deployed installation. Any refusal fails the gate closed.
 */
export async function mcpHandshakeGate(input: {
  readonly launcherPath?: string;
  readonly configPath?: string;
  readonly contractPath?: string;
} = {}): Promise<ReleaseGate> {
  const launcherPath = input.launcherPath ?? process.env["JARVIS_SECOND_BRAIN_LAUNCHER"];
  const configPath = input.configPath ?? process.env["JARVIS_SECOND_BRAIN_CONFIG"];
  const observed = { launcher_configured: launcherPath !== undefined, contract_profile: SECOND_BRAIN_CONTRACT_PROFILE };
  let transport: ReturnType<typeof createSecondBrainTransport>;
  try {
    transport = createSecondBrainTransport({
      launcherPath, configPath, contractPath: input.contractPath, safeReadRetries: 0,
    });
  } catch (error) {
    return gate("mcp-handshake", false, { ...observed, protocol_version: null },
      error instanceof SecondBrainTransportError ? error.code : "SECOND_BRAIN_HANDSHAKE_FAILED");
  }
  let result: ReleaseGate;
  try {
    await transport.restart();
    const facts = attestedSecondBrainHandshake(transport.diagnostics());
    if (facts === undefined) {
      result = gate("mcp-handshake", false, { ...observed, protocol_version: null }, "SECOND_BRAIN_HANDSHAKE_MALFORMED");
    } else {
      const ok = facts.protocol_version === SECOND_BRAIN_PROTOCOL_VERSION;
      result = gate("mcp-handshake", ok, {
        ...observed,
        protocol_version: facts.protocol_version,
        expected_protocol_version: SECOND_BRAIN_PROTOCOL_VERSION,
        server_name: facts.server_name,
        server_version: facts.server_version,
        tools: facts.tools,
      }, ok ? undefined : "SECOND_BRAIN_VERSION_MISMATCH");
    }
  } catch (error) {
    result = gate("mcp-handshake", false, { ...observed, protocol_version: null },
      error instanceof SecondBrainTransportError ? error.code : "SECOND_BRAIN_HANDSHAKE_FAILED");
  }
  try {
    await transport.close();
  } catch {
    return gate("mcp-handshake", false, { ...observed, protocol_version: null }, "SECOND_BRAIN_HANDSHAKE_FAILED");
  }
  return result;
}

async function doctorGate(options: ReleaseGateOptions, now: Date): Promise<ReleaseGate> {
  const db = new AuthorityDb(options.dbPath, undefined, { readonly: true, fileMustExist: true });
  try {
    const report = await runDoctor(db, now, options.capabilityProbe, options.secondBrainProbe);
    return gate("doctor", report.ok, {
      failed_checks: report.checks.filter(check => !check.ok).map(check => ({ name: check.name, code: check.code })),
      checks: report.checks.length,
    }, report.ok ? undefined : "RELEASE_GATE_DOCTOR_FAILED");
  } catch {
    return gate("doctor", false, { failed_checks: null }, "RELEASE_GATE_DOCTOR_UNAVAILABLE");
  } finally {
    db.close();
  }
}

function statusGate(dbPath: string): ReleaseGate {
  const db = new AuthorityDb(dbPath, undefined, { readonly: true, fileMustExist: true });
  try {
    const status = db.status();
    const pending = Number(status["pending_outbox"] ?? 0);
    return gate("status", pending === 0, { states: status["states"], pending_outbox: pending },
      pending === 0 ? undefined : "RELEASE_GATE_STATUS_PENDING");
  } catch {
    return gate("status", false, { states: null }, "RELEASE_GATE_STATUS_UNAVAILABLE");
  } finally {
    db.close();
  }
}

/** Runs all nine gates. The aggregate is not ok unless every gate is ok. */
export async function runReleaseGates(options: ReleaseGateOptions): Promise<ReleaseGateReport> {
  const now = options.now ?? new Date();
  const gates: ReleaseGate[] = [
    await migrationVectorGate(options.dbPath),
    quickCheckGate(options.dbPath),
    foreignKeyCheckGate(options.dbPath),
    await doctorGate(options, now),
    statusGate(options.dbPath),
    await dashboardHealthGate({ url: options.dashboardUrl, timeoutMs: options.dashboardTimeoutMs }),
    await mcpHandshakeGate({
      launcherPath: options.launcherPath, configPath: options.configPath, contractPath: options.contractPath,
    }),
    schedulerCursorGate(options.dbPath),
    uncertainOutboxGate(options.dbPath),
  ];
  const failed = gates.filter(item => !item.ok).map(item => item.name);
  return {
    schema_version: 1,
    ok: failed.length === 0,
    checked_at: Number.isFinite(now.getTime()) ? now.toISOString() : null,
    database: options.dbPath,
    gates,
    failed,
  };
}
