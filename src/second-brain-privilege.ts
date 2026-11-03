import { execFile, type ExecFileException } from "node:child_process";

/**
 * Root must not run a Second Brain child. A root `sb` or MCP launcher leaves root-owned vault
 * locks, and the handshake child then exits. Only that child drops to jm. The caller stays as it
 * is, so a root release gate can still open the service database, which jm cannot read.
 */
export function secondBrainChildCommand(
  file: string,
  args: readonly string[],
  uid: number | undefined,
  preserveEnv: readonly string[] = ["SB_CONFIG"],
): { readonly file: string; readonly args: readonly string[] } {
  if (uid !== 0) return { file, args };
  return {
    file: "/usr/bin/sudo",
    args: ["-n", "-u", "jm", `--preserve-env=${preserveEnv.join(",")}`, "--", file, ...args],
  };
}

export function secondBrainCallerUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/**
 * `doctor` is asked for its machine-readable document. The human lines are not a parseable contract.
 */
export function secondBrainProbeArguments(command: "status" | "doctor"): readonly string[] {
  return command === "doctor" ? ["doctor", "--json"] : ["status"];
}

export function secondBrainProbeCommand(
  command: "status" | "doctor",
  cli: string,
  uid: number | undefined,
): { readonly file: string; readonly args: readonly string[] } {
  return secondBrainChildCommand(cli, secondBrainProbeArguments(command), uid);
}

export type SecondBrainProbeExecFile = (
  file: string,
  args: readonly string[],
  options: {
    readonly encoding: "utf8";
    readonly timeout: number;
    readonly maxBuffer: number;
    readonly killSignal: "SIGKILL";
    readonly windowsHide: true;
    readonly env: { readonly SB_CONFIG: string; readonly PATH: string; readonly LANG: "C" };
  },
  callback: (error: ExecFileException | null, stdout: string) => void,
) => void;

export const defaultSecondBrainProbeExec: SecondBrainProbeExecFile = (file, args, options, callback) => {
  execFile(file, [...args], options, callback);
};
