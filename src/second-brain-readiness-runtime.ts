import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { probeSecondBrainConfiguration } from "./second-brain-readiness-config.js";
import {
  parseSecondBrainHandshakeFacts,
  type SecondBrainHandshakeFacts,
} from "./second-brain-readiness-handshake.js";
import {
  parseSecondBrainDoctorReport,
  parseSecondBrainLegacyStatus,
} from "./second-brain-readiness-facts.js";
import {
  UNREAD_SECOND_BRAIN_FACTS,
  attestedSecondBrainHandshakeRead,
  type SecondBrainHandshakeResult,
  type SecondBrainReadFacts,
} from "./second-brain-readiness-read.js";
import {
  configuredRefreshReceiptPath,
  secondBrainRefreshObservation,
} from "./second-brain-readiness-refresh.js";
import { SECOND_BRAIN_FROZEN_DIGEST } from "./second-brain-readiness.js";
import type {
  SecondBrainProbeFailure,
  SecondBrainProbeOutcome,
  SecondBrainReadinessObservation,
  SecondBrainReadinessProbe,
  SecondBrainRefreshObservation,
} from "./second-brain-readiness.js";
import { resolveDeploymentRoots } from "./personal-os-deployment-roots.js";

/**
 * An isolated provider installation is selected by JARVIS_SECOND_BRAIN_LAUNCHER/CONFIG, and when it
 * is, nothing under the deployed installation is opened: the legacy `sb` CLI is resolved beside the
 * configured launcher instead of under the deployed `app/current`.
 */
function configuredEndpoint(): {
  readonly launcher: string;
  readonly config: string;
  readonly cli: string;
} {
  const roots = resolveDeploymentRoots();
  const launcher = process.env["JARVIS_SECOND_BRAIN_LAUNCHER"];
  const config = process.env["JARVIS_SECOND_BRAIN_CONFIG"];
  if (launcher === undefined) return { launcher: roots.providerLauncher, config: roots.providerConfig, cli: roots.providerCli };
  return { launcher, config: config ?? roots.providerConfig, cli: join(dirname(launcher), "sb") };
}
const PROBE_TIMEOUT_MS = 5_000;
// The provider's JSON doctor report is one bounded document per configured check, so the ceiling
// has to clear a real installation's checks. At 2 KiB the deployed release's own report was within
// bytes of being reported as `oversize` instead of read.
const PROBE_MAX_BYTES = 16_384;

export type SecondBrainCommandResult =
  | { readonly kind: "ok"; readonly stdout: string }
  | { readonly kind: SecondBrainProbeFailure };
export type { SecondBrainHandshakeResult, SecondBrainReadFacts } from "./second-brain-readiness-read.js";

/**
 * The exact argument vector each probe runs.
 *
 * `doctor` is asked for its machine-readable document: the human `PASS name: detail` lines it
 * prints by default are not a parseable contract, and treating them as one is what reported a
 * healthy provider as `doctor_malformed`.
 */
export function secondBrainProbeArguments(command: "status" | "doctor"): readonly string[] {
  return command === "doctor" ? ["doctor", "--json"] : ["status"];
}
export interface SecondBrainReadinessRunner {
  executable(): Promise<"available" | "missing" | "unavailable">;
  configuration(): Promise<SecondBrainReadinessObservation["configuration"]>;
  run(command: "status" | "doctor"): Promise<SecondBrainCommandResult>;
  handshake(): Promise<SecondBrainHandshakeResult>;
}

function commandResult(command: "status" | "doctor"): Promise<SecondBrainCommandResult> {
  const endpoint = configuredEndpoint();
  return new Promise(resolve => {
    execFile(endpoint.cli, [...secondBrainProbeArguments(command)], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BYTES,
      killSignal: "SIGKILL",
      windowsHide: true,
      env: { SB_CONFIG: endpoint.config, PATH: "/usr/bin:/bin", LANG: "C" },
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
        const metadata = await stat(configuredEndpoint().launcher);
        return metadata.isFile() && (metadata.mode & 0o111) !== 0 ? "available" : "missing";
      } catch (error) {
        if (!(error instanceof Error)) return "unavailable";
        return property(error, "code") === "ENOENT" ? "missing" : "unavailable";
      }
    },
    configuration: () => probeSecondBrainConfiguration(configuredEndpoint().config),
    run: commandResult,
    handshake: () => attestedSecondBrainHandshakeRead(configuredEndpoint()),
  };
}

function unavailableBase(
  executable: SecondBrainReadinessObservation["executable"],
  configuration: SecondBrainReadinessObservation["configuration"],
  refresh: SecondBrainRefreshObservation,
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
    // A receipt is a file the provider left behind, not something the provider has to be running to
    // answer for, so an unreachable provider does not erase the last refresh it published.
    refresh,
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

type DoctorProbe = {
  readonly outcome: SecondBrainProbeOutcome;
  readonly operational: boolean | null;
};

function parseDoctor(result: SecondBrainCommandResult): DoctorProbe {
  if (result.kind !== "ok") return { outcome: result.kind, operational: null };
  const report = parseSecondBrainDoctorReport(result.stdout);
  return report === undefined
    ? { outcome: "malformed", operational: null }
    : { outcome: "ok", operational: report.operational };
}

function parseHandshake(result: SecondBrainHandshakeResult): {
  readonly outcome: SecondBrainProbeOutcome;
  readonly facts: SecondBrainHandshakeFacts | undefined;
  readonly read: SecondBrainReadFacts;
} {
  if (result.kind !== "ok") {
    return { outcome: result.kind, facts: undefined, read: UNREAD_SECOND_BRAIN_FACTS };
  }
  const facts = result.facts ?? parseSecondBrainHandshakeFacts(result.stdout);
  const read = result.read ?? UNREAD_SECOND_BRAIN_FACTS;
  return facts === undefined
    ? { outcome: "malformed", facts, read }
    : { outcome: "ok", facts, read };
}

function refreshObservation(
  legacy: ReturnType<typeof parseSecondBrainLegacyStatus>,
): SecondBrainRefreshObservation {
  const attempt = legacy?.latest_refresh_attempt;
  if (attempt === null || attempt === undefined) return { kind: "missing" };
  // A successful stage log carries the stage's started_at, not a refresh completion timestamp or a
  // whole-run proof, so it can never become `last_successful_refresh`. Reporting it as `missing`
  // also erased the attempt: an operator could not tell a provider that never ran from one whose
  // hourly run succeeded. The attempt is kept, and the success timestamp stays absent.
  if (attempt.kind === "success") return { kind: "success_attempted", attempted_at: attempt.at };
  return { kind: attempt.kind, attempted_at: attempt.at };
}

export function runtimeSecondBrainReadinessProbe(
  runner: SecondBrainReadinessRunner = boundedSecondBrainReadinessRunner(),
  receiptPath: string | undefined = configuredRefreshReceiptPath(),
): SecondBrainReadinessProbe {
  return {
    inspect: async () => {
      const receipt = secondBrainRefreshObservation(receiptPath);
      const executable = await runner.executable();
      if (executable !== "available") {
        return unavailableBase(executable, "unavailable", receipt ?? { kind: "missing" });
      }
      const configuration = await runner.configuration();
      if (configuration !== "valid") {
        return unavailableBase(executable, configuration, receipt ?? { kind: "missing" });
      }
      const status = parseStatus(await runner.run("status"));
      const doctor = parseDoctor(await runner.run("doctor"));
      const handshake = parseHandshake(await runner.handshake());
      const facts = handshake.facts;
      const schemas = handshake.read.contract_digest !== null
        && handshake.read.contract_digest === SECOND_BRAIN_FROZEN_DIGEST;
      return {
        executable,
        configuration,
        // The digest the provider itself reports for the contract it implements, compared against
        // the frozen artifact this release validated its tools/list against.
        contract_digest: handshake.read.contract_digest,
        protocol_version: facts?.protocol_version ?? null,
        tools: facts?.tools ?? null,
        schemas_compatible: schemas,
        // A provider reporting the frozen contract's own digest declares the frozen input and
        // output schemas; the transport separately refused to reach `ready` unless the live
        // tools/list matched that same artifact.
        input_schemas_compatible: facts === undefined ? null : schemas,
        output_schemas_compatible: facts === undefined ? null : schemas,
        status: status.outcome,
        doctor: doctor.outcome,
        handshake: handshake.outcome,
        status_operational: status.outcome === "ok" ? true : null,
        doctor_operational: doctor.operational,
        channels_consistent: status.outcome === "ok" && doctor.outcome === "ok"
          && handshake.outcome === "ok",
        read_authorization: handshake.read.read,
        // Readiness never attempts a write. The provider answers on its read surface instead, and a
        // release that does not answer leaves the stage at read_only rather than guessing.
        write_authorization: handshake.read.write ?? "unauthorized",
        authorization_consistent: true,
        data_state: handshake.read.data_state,
        // The published receipt is the only completion evidence; the status line can prove an
        // attempt and nothing more, so it is the fallback and never an override.
        refresh: receipt ?? refreshObservation(status.legacy),
        last_successful_refresh_at: status.legacy?.last_successful_refresh_at ?? null,
      };
    },
  };
}

export const SECOND_BRAIN_READINESS_CACHE_TTL_MS = 30_000;

export function cachedSecondBrainReadinessProbe(
  inner: SecondBrainReadinessProbe,
  ttlMs = SECOND_BRAIN_READINESS_CACHE_TTL_MS,
  now: () => Date = () => new Date(),
): SecondBrainReadinessProbe {
  let cached: { at: number; value: SecondBrainReadinessObservation } | undefined;
  let inflight: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    inflight ??= inner.inspect().then((value) => {
      cached = { at: now().getTime(), value };
    }).finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
  return {
    inspect: async () => {
      const age = cached === undefined ? Number.POSITIVE_INFINITY : now().getTime() - cached.at;
      if (cached !== undefined && age < ttlMs) return cached.value;
      if (cached !== undefined) {
        void refresh();
        return cached.value;
      }
      await refresh();
      if (cached === undefined) throw new Error("SECOND_BRAIN_READINESS_CACHE_EMPTY");
      return cached.value;
    },
  };
}

let sharedHealthProbe: SecondBrainReadinessProbe | undefined;
export function cachedRuntimeSecondBrainReadinessProbe(): SecondBrainReadinessProbe {
  sharedHealthProbe ??= cachedSecondBrainReadinessProbe(runtimeSecondBrainReadinessProbe());
  return sharedHealthProbe;
}

export { probeSecondBrainConfiguration } from "./second-brain-readiness-config.js";
