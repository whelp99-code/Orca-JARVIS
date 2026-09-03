import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { probeSecondBrainConfiguration } from "./second-brain-readiness-config.js";
import {
  attestedSecondBrainHandshake,
  parseSecondBrainHandshakeFacts,
  type SecondBrainHandshakeFacts,
} from "./second-brain-readiness-handshake.js";
import { parseSecondBrainLegacyStatus } from "./second-brain-readiness-facts.js";
import type {
  SecondBrainProbeFailure,
  SecondBrainProbeOutcome,
  SecondBrainReadinessObservation,
  SecondBrainReadinessProbe,
  SecondBrainRefreshObservation,
} from "./second-brain-readiness.js";
import {
  SECOND_BRAIN_CONFIG,
  SECOND_BRAIN_LAUNCHER,
  SecondBrainTransportError,
  createSecondBrainTransport,
} from "./second-brain-transport.js";

const SECOND_BRAIN_CLI = "/home/jm/.local/state/second-brain/app/current/bin/sb";
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BYTES = 2_048;

export type SecondBrainCommandResult =
  | { readonly kind: "ok"; readonly stdout: string }
  | { readonly kind: SecondBrainProbeFailure };
export type SecondBrainHandshakeResult =
  | { readonly kind: "ok"; readonly stdout: string; readonly facts?: SecondBrainHandshakeFacts }
  | { readonly kind: SecondBrainProbeFailure };
export interface SecondBrainReadinessRunner {
  executable(): Promise<"available" | "missing" | "unavailable">;
  configuration(): Promise<"valid" | "missing" | "malformed" | "unavailable">;
  run(command: "status" | "doctor"): Promise<SecondBrainCommandResult>;
  handshake(): Promise<SecondBrainHandshakeResult>;
}

function commandResult(command: "status" | "doctor"): Promise<SecondBrainCommandResult> {
  return new Promise(resolve => {
    execFile(SECOND_BRAIN_CLI, [command], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BYTES,
      killSignal: "SIGKILL",
      windowsHide: true,
      env: { SB_CONFIG: SECOND_BRAIN_CONFIG, PATH: "/usr/bin:/bin", LANG: "C" },
    }, (error, stdout) => {
      if (error === null) {
        resolve({ kind: "ok", stdout });
        return;
      }
      resolve({ kind: commandFailure(error) });
    });
  });
}

function commandFailure(error: unknown): SecondBrainProbeFailure {
  const code = property(error, "code");
  const killed = property(error, "killed");
  const signal = property(error, "signal");
  if (code === "ENOENT") return "unavailable";
  if (killed === true || signal === "SIGKILL") return "timeout";
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "oversize";
  return signal === undefined ? "nonzero" : "crash";
}

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

export function boundedSecondBrainReadinessRunner(): SecondBrainReadinessRunner {
  return {
    executable: async () => {
      try {
        const metadata = await stat(SECOND_BRAIN_LAUNCHER);
        return metadata.isFile() && (metadata.mode & 0o111) !== 0 ? "available" : "missing";
      } catch (error) {
        if (!(error instanceof Error)) return "unavailable";
        return property(error, "code") === "ENOENT" ? "missing" : "unavailable";
      }
    },
    configuration: () => probeSecondBrainConfiguration(SECOND_BRAIN_CONFIG),
    run: commandResult,
    handshake: async () => {
      const transport = createSecondBrainTransport({ safeReadRetries: 0 });
      let result: SecondBrainHandshakeResult;
      try {
        await transport.restart();
        const facts = attestedSecondBrainHandshake(transport.diagnostics());
        result = facts === undefined ? { kind: "malformed" } : { kind: "ok", stdout: "", facts };
      } catch (error) {
        if (!(error instanceof SecondBrainTransportError)) throw error;
        result = { kind: transportFailure(error) };
      }
      try {
        await transport.close();
      } catch (error) {
        if (!(error instanceof SecondBrainTransportError)) throw error;
        return { kind: "unavailable" };
      }
      return result;
    },
  };
}

function transportFailure(error: SecondBrainTransportError): SecondBrainProbeFailure {
  if (error.code === "SECOND_BRAIN_STARTUP_TIMEOUT") return "timeout";
  if (error.code === "SECOND_BRAIN_OVERSIZE_FRAME") return "oversize";
  if (error.code === "SECOND_BRAIN_CHILD_EXIT") return "crash";
  return "malformed";
}

function unavailableBase(
  executable: SecondBrainReadinessObservation["executable"],
  configuration: SecondBrainReadinessObservation["configuration"],
): SecondBrainReadinessObservation {
  return {
    executable,
    configuration,
    contract_digest: null,
    protocol_version: null,
    tools: null,
    schemas_compatible: false,
    status: "unavailable",
    doctor: "unavailable",
    handshake: "unavailable",
    status_operational: null,
    doctor_operational: null,
    read_authorization: "unauthorized",
    write_authorization: "unauthorized",
    data_state: "unknown",
    refresh: { kind: "missing" },
  };
}

type StatusProbe = {
  readonly outcome: SecondBrainProbeOutcome;
  readonly legacy: ReturnType<typeof parseSecondBrainLegacyStatus>;
};

function parseStatus(result: SecondBrainCommandResult): StatusProbe {
  if (result.kind !== "ok") return { outcome: result.kind, legacy: undefined };
  const legacy = parseSecondBrainLegacyStatus(result.stdout);
  return legacy === undefined ? { outcome: "malformed", legacy } : { outcome: "ok", legacy };
}

function parseDoctor(result: SecondBrainCommandResult): SecondBrainProbeOutcome {
  if (result.kind !== "ok") return result.kind;
  return result.stdout.trim() === "" ? "ok" : "malformed";
}

function parseHandshake(result: SecondBrainHandshakeResult): {
  readonly outcome: SecondBrainProbeOutcome;
  readonly facts: SecondBrainHandshakeFacts | undefined;
} {
  if (result.kind !== "ok") return { outcome: result.kind, facts: undefined };
  const facts = result.facts ?? parseSecondBrainHandshakeFacts(result.stdout);
  return facts === undefined ? { outcome: "malformed", facts } : { outcome: "ok", facts };
}

function refreshObservation(
  legacy: ReturnType<typeof parseSecondBrainLegacyStatus>,
): SecondBrainRefreshObservation {
  const attempt = legacy?.latest_refresh_attempt;
  if (attempt === null || attempt === undefined) return { kind: "missing" };
  if (attempt.kind === "success") return { kind: "success", completed_at: attempt.at };
  return { kind: attempt.kind, attempted_at: attempt.at };
}

export function runtimeSecondBrainReadinessProbe(
  runner: SecondBrainReadinessRunner = boundedSecondBrainReadinessRunner(),
): SecondBrainReadinessProbe {
  return {
    inspect: async () => {
      const executable = await runner.executable();
      if (executable !== "available") return unavailableBase(executable, "unavailable");
      const configuration = await runner.configuration();
      if (configuration !== "valid") return unavailableBase(executable, configuration);
      const status = parseStatus(await runner.run("status"));
      const doctor = parseDoctor(await runner.run("doctor"));
      const handshake = parseHandshake(await runner.handshake());
      const facts = handshake.facts;
      return {
        executable,
        configuration,
        contract_digest: null,
        protocol_version: facts?.protocol_version ?? null,
        tools: facts?.tools ?? null,
        schemas_compatible: facts?.input_schemas_compatible === true
          && facts.output_schemas_compatible === true,
        input_schemas_compatible: facts?.input_schemas_compatible ?? null,
        output_schemas_compatible: facts?.output_schemas_compatible ?? null,
        status: status.outcome,
        doctor,
        handshake: handshake.outcome,
        status_operational: null,
        doctor_operational: null,
        channels_consistent: status.outcome === "ok" && doctor === "ok" && handshake.outcome === "ok",
        read_authorization: "unauthorized",
        write_authorization: "unauthorized",
        authorization_consistent: true,
        data_state: status.outcome === "ok" ? status.legacy?.data_state ?? "unknown"
          : status.outcome === "malformed" ? "unknown" : "unavailable",
        refresh: refreshObservation(status.legacy),
        last_successful_refresh_at: status.legacy?.last_successful_refresh_at ?? null,
      };
    },
  };
}

export { probeSecondBrainConfiguration } from "./second-brain-readiness-config.js";
