import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import {
  SECOND_BRAIN_CONFIG,
  SECOND_BRAIN_LAUNCHER,
  SECOND_BRAIN_PROTOCOL_VERSION,
  SecondBrainTransportError,
  createSecondBrainTransport,
} from "./second-brain-transport.js";
import {
  SECOND_BRAIN_FROZEN_DIGEST,
  SECOND_BRAIN_REQUIRED_TOOLS,
  type SecondBrainProbeFailure,
  type SecondBrainReadinessObservation,
  type SecondBrainReadinessProbe,
  type SecondBrainRefreshObservation,
} from "./second-brain-readiness.js";

const SECOND_BRAIN_CLI = "/home/jm/.local/bin/sb";
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BYTES = 2_048;
const CONFIG_MAX_BYTES = 65_536;
const STATUS_PATTERN = /^(\d{4}-\d\d-\d\dT\S+) run \S+ (ok|capped|failed) pages=(\d+) conflicts=\d+ errors=\d+$/;

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

function parseStatus(result: SecondBrainCommandResult): {
  readonly outcome: SecondBrainReadinessObservation["status"];
  readonly data: SecondBrainReadinessObservation["data_state"];
  readonly refresh: SecondBrainRefreshObservation;
} {
  if (result.kind !== "ok") return { outcome: result.kind, data: "unavailable", refresh: { kind: "missing" } };
  const text = result.stdout.trim();
  if (text === "no runs") return { outcome: "ok", data: "no_data", refresh: { kind: "missing" } };
  const matched = STATUS_PATTERN.exec(text);
  if (matched === null) return { outcome: "malformed", data: "unknown", refresh: { kind: "missing" } };
  const observed = matched[1];
  const status = matched[2];
  const pages = Number(matched[3]);
  if (observed === undefined || status === undefined || !Number.isSafeInteger(pages)) {
    return { outcome: "malformed", data: "unknown", refresh: { kind: "missing" } };
  }
  const attempted_at = new Date(observed).toISOString();
  const refresh: SecondBrainRefreshObservation = status === "ok" ? { kind: "success", completed_at: attempted_at }
    : status === "capped" ? { kind: "capped", attempted_at } : { kind: "failed", attempted_at };
  const data = status === "ok" ? (pages === 0 ? "no_data" : "ready") : "unknown";
  return { outcome: "ok", data, refresh };
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
      const doctor = await runner.run("doctor");
      const handshake = await runner.handshake();
      const compatible = handshake.kind === "ok";
      return {
        executable, configuration,
        contract_digest: compatible ? SECOND_BRAIN_FROZEN_DIGEST : null,
        protocol_version: compatible ? SECOND_BRAIN_PROTOCOL_VERSION : null,
        tools: compatible ? SECOND_BRAIN_REQUIRED_TOOLS : null,
        schemas_compatible: compatible,
        status: status.outcome,
        doctor: doctor.kind,
        handshake: handshake.kind,
        read_authorization: compatible ? "authorized" : "unauthorized",
        write_authorization: "unauthorized",
        data_state: status.data,
        refresh: status.refresh,
      };
    },
  };
}
