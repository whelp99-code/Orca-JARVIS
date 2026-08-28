import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import { GJC_PROTOCOL_VERSION } from "./gjc.js";
import { LiveSupervisor } from "./live-supervisor.js";

export type CapabilityStage =
  | "installed"
  | "configured"
  | "protocol_compatible"
  | "operational"
  | "authorized";

export interface CapabilityStageResult {
  ok: boolean;
  evidence: string;
}

export interface CapabilityFact {
  id: "codex" | "claude" | "orca_read" | "gjc" | "live_resume";
  stages: Record<CapabilityStage, CapabilityStageResult>;
}

export interface CapabilityMatrixV1 {
  schema_version: 1;
  checked_at: string | null;
  capabilities: CapabilityFact[];
  error?: { readonly code: "CAPABILITY_CLOCK_INVALID" };
}

export interface CapabilityProbe {
  inspect(id: CapabilityFact["id"]): Promise<{
    installed: { ok: boolean; version: string | null; evidence: string };
    configured: { ok: boolean; evidence: string };
    protocol_compatible: { ok: boolean; protocol_version: string | null; evidence: string };
    operational: { ok: boolean; evidence: string };
    authorized: { ok: boolean; evidence: string };
  }>;
}

type CapabilityProbeObservation = Awaited<ReturnType<CapabilityProbe["inspect"]>>;

const CAPABILITY_IDS = ["codex", "claude", "orca_read", "gjc", "live_resume"] as const;
const STAGES = ["installed", "configured", "protocol_compatible", "operational", "authorized"] as const;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PROTOCOL = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_EVIDENCE = new Set([
  "adapter_present", "authority_present", "authority_unverified", "client_present", "configuration_present", "configuration_unverified",
  "executable_present", "gjc_not_operational", "incompatible_protocol", "library_present", "live_resume_not_configured", "migrations_pending",
  "missing_executable", "probe_timeout", "protocol_compatible", "protocol_unverified", "protocol_version_unparsed", "read_only",
  "runtime_healthy", "runtime_unverified", "version_unparsed", "redacted_probe_failure",
]);
const REDACTED = "redacted_probe_failure";

const invalid = (): never => { throw new JarvisError("CAPABILITY_INPUT_INVALID"); };
const object = (value: unknown): Record<string, unknown> => value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  ? value as Record<string, unknown>
  : invalid();
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
};
const evidenceOf = (value: unknown): string => typeof value === "string" && value.length > 0 ? value : invalid();
const boundEvidence = (value: string): string => SAFE_EVIDENCE.has(value) ? value : REDACTED;
const stageBase = (value: unknown, keys: readonly string[]): { ok: boolean; evidence: string; version?: string | null; protocol_version?: string | null } => {
  const input = object(value);
  exactKeys(input, keys);
  if (typeof input.ok !== "boolean") invalid();
  const ok: boolean = input.ok === true;
  const evidence = evidenceOf(input.evidence);
  const version = Object.hasOwn(input, "version") ? (input.version === null || typeof input.version === "string" ? input.version : invalid()) : undefined;
  const protocol_version = Object.hasOwn(input, "protocol_version")
    ? (input.protocol_version === null || typeof input.protocol_version === "string"
      ? input.protocol_version
      : invalid())
    : undefined;
  return { ok, evidence, version, protocol_version };
};

function parseObservation(value: unknown): CapabilityProbeObservation {
  const input = object(value);
  exactKeys(input, STAGES);
  const installed = stageBase(input.installed, ["ok", "version", "evidence"]);
  if (installed.version !== null && typeof installed.version !== "string") invalid();
  const configured = stageBase(input.configured, ["ok", "evidence"]);
  const protocol = stageBase(input.protocol_compatible, ["ok", "protocol_version", "evidence"]);
  if (protocol.protocol_version !== null && typeof protocol.protocol_version !== "string") invalid();
  const operational = stageBase(input.operational, ["ok", "evidence"]);
  const authorized = stageBase(input.authorized, ["ok", "evidence"]);
  return {
    installed: { ok: installed.ok, version: installed.version === null ? null : String(installed.version), evidence: installed.evidence },
    configured: { ok: configured.ok, evidence: configured.evidence },
    protocol_compatible: {
      ok: protocol.ok,
      protocol_version: protocol.protocol_version === null ? null : String(protocol.protocol_version),
      evidence: protocol.evidence,
    },
    operational: { ok: operational.ok, evidence: operational.evidence },
    authorized: { ok: authorized.ok, evidence: authorized.evidence },
  };
}

function evaluate(id: CapabilityFact["id"], raw: unknown, gjcOperational: boolean, liveResumeConfigured: boolean): CapabilityFact {
  const observation = parseObservation(raw);
  let installedOk = observation.installed.ok;
  let installedEvidence = observation.installed.evidence;
  if (installedOk && (observation.installed.version === null ? id !== "orca_read" : !VERSION.test(observation.installed.version))) {
    installedOk = false;
    installedEvidence = "version_unparsed";
  }

  let configuredOk = observation.configured.ok;
  let configuredEvidence = observation.configured.evidence;
  if (id === "live_resume" && !liveResumeConfigured) {
    configuredOk = false;
    configuredEvidence = "live_resume_not_configured";
  }

  let protocolOk = observation.protocol_compatible.ok;
  let protocolEvidence = observation.protocol_compatible.evidence;
  if (protocolOk) {
    const version = observation.protocol_compatible.protocol_version;
    if (version === null || !PROTOCOL.test(version)) {
      protocolOk = false;
      protocolEvidence = "protocol_version_unparsed";
    } else if (id === "gjc" && version !== GJC_PROTOCOL_VERSION) {
      protocolOk = false;
      protocolEvidence = "incompatible_protocol";
    }
  }

  let operationalOk = observation.operational.ok;
  let operationalEvidence = observation.operational.evidence;
  if (id === "gjc" && !gjcOperational) {
    operationalOk = false;
    operationalEvidence = "gjc_not_operational";
  }

  const observed: Record<CapabilityStage, CapabilityStageResult> = {
    installed: { ok: installedOk, evidence: installedEvidence },
    configured: { ok: configuredOk, evidence: configuredEvidence },
    protocol_compatible: { ok: protocolOk, evidence: protocolEvidence },
    operational: { ok: operationalOk, evidence: operationalEvidence },
    authorized: { ok: observation.authorized.ok, evidence: observation.authorized.evidence },
  };

  const stages = {} as Record<CapabilityStage, CapabilityStageResult>;
  let allowed = true;
  for (const stage of STAGES) {
    const ok = allowed && observed[stage].ok;
    if (!ok) allowed = false;
    stages[stage] = { ok, evidence: boundEvidence(observed[stage].evidence) };
  }
  return { id, stages };
}

const failedStages = (): Record<CapabilityStage, CapabilityStageResult> => {
  const stages = {} as Record<CapabilityStage, CapabilityStageResult>;
  for (const stage of STAGES) stages[stage] = { ok: false, evidence: REDACTED };
  return stages;
};

export async function buildCapabilityMatrix(
  db: AuthorityDb,
  probe: CapabilityProbe,
  now = new Date(),
): Promise<CapabilityMatrixV1> {
  if (!Number.isFinite(now.getTime())) {
    return {
      schema_version: 1,
      checked_at: null,
      capabilities: CAPABILITY_IDS.map(id => ({ id, stages: failedStages() })),
      error: { code: "CAPABILITY_CLOCK_INVALID" },
    };
  }
  const gjcOperational = db.gjcOperational();
  const liveResumeConfigured = new LiveSupervisor(db).liveResumeConfigured();
  const capabilities: CapabilityFact[] = [];
  for (const id of CAPABILITY_IDS) {
    try {
      capabilities.push(evaluate(id, await probe.inspect(id), gjcOperational, liveResumeConfigured));
    } catch (error) {
      if (error instanceof JarvisError && error.code === "CAPABILITY_INPUT_INVALID") throw error;
      capabilities.push({ id, stages: failedStages() });
    }
  }
  return { schema_version: 1, checked_at: now.toISOString(), capabilities };
}
