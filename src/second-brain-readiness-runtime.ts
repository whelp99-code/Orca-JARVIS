import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import {
  SECOND_BRAIN_CONFIG,
  SECOND_BRAIN_LAUNCHER,
  SecondBrainTransportError,
  createSecondBrainTransport,
} from "./second-brain-transport.js";
import { combineSecondBrainFacts } from "./second-brain-readiness-combine.js";
import {
  parseSecondBrainLegacyStatus,
  parseSecondBrainPeerFacts,
  type SecondBrainPeerFacts,
} from "./second-brain-readiness-facts.js";
import {
  type SecondBrainProbeFailure,
  type SecondBrainProbeOutcome,
  type SecondBrainReadinessObservation,
  type SecondBrainReadinessProbe,
  type SecondBrainRefreshObservation,
} from "./second-brain-readiness.js";

const SECOND_BRAIN_CLI = "/home/jm/.local/bin/sb";
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BYTES = 2_048;
const CONFIG_MAX_BYTES = 65_536;

export type SecondBrainCommandResult =
  | { readonly kind: "ok"; readonly stdout: string }
  | { readonly kind: SecondBrainProbeFailure };
export interface SecondBrainReadinessRunner {
  executable(): Promise<"available" | "missing" | "unavailable">;
  configuration(): Promise<"valid" | "missing" | "malformed" | "unavailable">;
  run(command: "status" | "doctor"): Promise<SecondBrainCommandResult>;
  handshake(): Promise<SecondBrainCommandResult>;
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
      const failure = error as NodeJS.ErrnoException & { readonly killed?: boolean; readonly signal?: string };
      if (failure.code === "ENOENT") resolve({ kind: "unavailable" });
      else if (failure.killed === true || failure.signal === "SIGKILL") resolve({ kind: "timeout" });
      else if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") resolve({ kind: "oversize" });
      else if (failure.signal !== undefined) resolve({ kind: "crash" });
      else resolve({ kind: "nonzero" });
    });
  });
}

export function boundedSecondBrainReadinessRunner(): SecondBrainReadinessRunner {
  return {
    executable: async () => {
      try {
        const metadata = await stat(SECOND_BRAIN_LAUNCHER);
        return metadata.isFile() && (metadata.mode & 0o111) !== 0 ? "available" : "missing";
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
        return "unavailable";
      }
    },
    configuration: async () => {
      try {
        const metadata = await stat(SECOND_BRAIN_CONFIG);
        if (!metadata.isFile() || metadata.size < 1 || metadata.size > CONFIG_MAX_BYTES) return "malformed";
        const value = await readFile(SECOND_BRAIN_CONFIG, "utf8");
        return /^vault_root\s*=\s*"[^"\r\n]+"/m.test(value) ? "valid" : "malformed";
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
        return "unavailable";
      }
    },
    run: commandResult,
    handshake: async () => {
      const transport = createSecondBrainTransport({ safeReadRetries: 0 });
      try {
        await transport.restart();
        return { kind: "ok", stdout: "" };
      } catch (error) {
        if (!(error instanceof SecondBrainTransportError)) throw error;
        if (error.code === "SECOND_BRAIN_STARTUP_TIMEOUT") return { kind: "timeout" };
        if (error.code === "SECOND_BRAIN_OVERSIZE_FRAME") return { kind: "oversize" };
        if (error.code === "SECOND_BRAIN_CHILD_EXIT") return { kind: "crash" };
        return { kind: "malformed" };
      } finally {
        await transport.close().catch(error => {
          if (!(error instanceof SecondBrainTransportError)) throw error;
        });
      }
    },
  };
}

function unavailableBase(
  executable: SecondBrainReadinessObservation["executable"],
  configuration: SecondBrainReadinessObservation["configuration"],
): SecondBrainReadinessObservation {
  return {
    executable, configuration, contract_digest: null, protocol_version: null, tools: null,
    schemas_compatible: false, status: "unavailable", doctor: "unavailable", handshake: "unavailable",
    read_authorization: "unauthorized", write_authorization: "unauthorized", data_state: "unknown",
    refresh: { kind: "missing" },
  };
}

type ParsedProbe = {
  readonly outcome: SecondBrainProbeOutcome;
  readonly facts: SecondBrainPeerFacts | undefined;
};

function parseFacts(result: SecondBrainCommandResult, allowLegacy: boolean): ParsedProbe & {
  readonly legacy: ReturnType<typeof parseSecondBrainLegacyStatus>;
} {
  if (result.kind !== "ok") return { outcome: result.kind, facts: undefined, legacy: undefined };
  const facts = parseSecondBrainPeerFacts(result.stdout);
  if (facts !== undefined) return { outcome: "ok", facts, legacy: undefined };
  const legacy = allowLegacy ? parseSecondBrainLegacyStatus(result.stdout) : undefined;
  if (legacy !== undefined || result.stdout.trim() === "") return { outcome: "ok", facts: undefined, legacy };
  return { outcome: "malformed", facts: undefined, legacy: undefined };
}

function refreshObservation(
  attempt: ReturnType<typeof combineSecondBrainFacts>["latest_refresh_attempt"],
): SecondBrainRefreshObservation {
  if (attempt === null) return { kind: "missing" };
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
      const status = parseFacts(await runner.run("status"), true);
      const doctor = parseFacts(await runner.run("doctor"), false);
      const handshake = parseFacts(await runner.handshake(), false);
      const facts = combineSecondBrainFacts({
        status: status.facts,
        doctor: doctor.facts,
        handshake: handshake.facts,
        legacy: status.legacy,
      });
      return {
        executable,
        configuration,
        contract_digest: handshake.facts === undefined ? null : facts.contract_digest,
        protocol_version: handshake.facts === undefined ? null : facts.protocol_version,
        tools: handshake.facts === undefined ? null : facts.tools,
        schemas_compatible: handshake.facts !== undefined
          && facts.input_schemas_compatible === true
          && facts.output_schemas_compatible === true,
        input_schemas_compatible: handshake.facts === undefined ? null : facts.input_schemas_compatible,
        output_schemas_compatible: handshake.facts === undefined ? null : facts.output_schemas_compatible,
        status: status.outcome,
        doctor: doctor.outcome,
        handshake: handshake.outcome,
        status_operational: facts.status_operational,
        doctor_operational: facts.doctor_operational,
        channels_consistent: facts.channels_consistent && status.outcome === "ok" && doctor.outcome === "ok",
        read_authorization: facts.authorization.read,
        write_authorization: facts.authorization.write,
        authorization_consistent: facts.authorization_consistent && facts.channels_consistent,
        data_state: status.outcome === "malformed" ? "unknown"
          : status.outcome === "ok" ? facts.data_state : "unavailable",
        refresh: refreshObservation(facts.latest_refresh_attempt),
        last_successful_refresh_at: facts.last_successful_refresh_at,
      };
    },
  };
}
