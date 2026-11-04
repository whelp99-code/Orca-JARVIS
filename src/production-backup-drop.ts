// Root must not write the production backup. The directory is owned by jarvis-svc,
// and the backup accepts only a caller whose uid matches that owner.
// Tests inject execFile and stat. This does not widen the owner check.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const PRODUCTION_BACKUP_SERVICE = "jarvis-svc";
export const PRODUCTION_BACKUP_SERVICE_UID = 960;

export type BackupExecFile = (
  file: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string } | string | void>;
export type BackupStat = (path: string) => { readonly uid: number; readonly mode: number };

export class ProductionBackupCommandError extends Error {
  readonly stderr: string;
  readonly exitCode: number;

  constructor(stderr: string, exitCode: number) {
    super("BACKUP_COMMAND_FAILED");
    this.name = "ProductionBackupCommandError";
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export function productionBackupChild(
  uid: number,
  stateRoot: string,
  command: readonly string[],
): { readonly file: string; readonly args: readonly string[] } {
  const executable = command[0];
  if (executable === undefined || executable === "") throw new Error("BACKUP_COMMAND");
  if (uid !== 0) return { file: executable, args: command.slice(1) };
  if (!stateRoot.startsWith("/")) throw new Error("BACKUP_STATE_ROOT");
  return {
    file: "/usr/bin/sudo",
    args: ["-n", "-u", PRODUCTION_BACKUP_SERVICE, "--", "/usr/bin/env", `JARVIS_STATE_ROOT=${stateRoot}`, ...command],
  };
}

export function backupResultPath(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("BACKUP_RESULT_PATH");
  }
  if (typeof parsed !== "object" || parsed === null || !("destPath" in parsed)) throw new Error("BACKUP_RESULT_PATH");
  const destPath = parsed.destPath;
  if (typeof destPath !== "string" || !destPath.startsWith("/")) throw new Error("BACKUP_RESULT_PATH");
  return destPath;
}

export async function runProductionBackup(input: {
  readonly uid: number;
  readonly stateRoot: string;
  readonly command: readonly string[];
  readonly execFile?: BackupExecFile;
  readonly destPath?: string;
  readonly expectedUid?: number;
  readonly stat?: BackupStat;
}): Promise<{ readonly spec: { readonly file: string; readonly args: readonly string[] }; readonly stdout: string; readonly destPath: string }> {
  const spec = productionBackupChild(input.uid, input.stateRoot, input.command);
  let stdout = "";
  try {
    const result = await (input.execFile ?? defaultExecFile)(spec.file, spec.args);
    stdout = typeof result === "string" ? result : result?.stdout ?? "";
  } catch (error) {
    throw commandFailure(error);
  }
  const destPath = input.destPath ?? backupResultPath(stdout);
  const info = (input.stat ?? defaultStat)(destPath);
  const expectedUid = input.expectedUid ?? (input.uid === 0 ? PRODUCTION_BACKUP_SERVICE_UID : input.uid);
  if ((info.mode & 0o777) !== 0o600 || info.uid !== expectedUid) throw new Error("BACKUP_FILE_OWNER");
  return { spec, stdout, destPath };
}

async function defaultExecFile(
  file: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, [...args], { encoding: "utf8" });
  return { stdout, stderr };
}

function commandFailure(error: unknown): ProductionBackupCommandError {
  if (error instanceof ProductionBackupCommandError) return error;
  const stderr = typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
    ? error.stderr
    : "";
  const exitCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "number"
    ? error.code
    : 1;
  return new ProductionBackupCommandError(stderr, exitCode);
}

function defaultStat(path: string): { readonly uid: number; readonly mode: number } {
  const info = statSync(path);
  return { uid: info.uid, mode: info.mode };
}

function callerIsMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

function flagValue(flagArgs: readonly string[], name: string): string | undefined {
  const index = flagArgs.indexOf(name);
  return index === -1 ? undefined : flagArgs[index + 1];
}

if (callerIsMain()) {
  const separator = process.argv.indexOf("--");
  const flagArgs = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator);
  const command = separator === -1 ? [] : process.argv.slice(separator + 1);
  const uidText = flagValue(flagArgs, "--uid");
  const stateRoot = flagValue(flagArgs, "--state-root") ?? "";
  const known = new Set(["--uid", "--state-root"]);
  const usage = flagArgs.some((flag, index) => index % 2 === 0 && !known.has(flag))
    || uidText === undefined
    || !/^[0-9]+$/.test(uidText);
  if (usage) {
    process.stderr.write("BACKUP_USAGE\n");
    process.exitCode = 2;
  } else {
    try {
      const { stdout } = await runProductionBackup({ uid: Number(uidText), stateRoot, command });
      process.stdout.write(stdout);
    } catch (error) {
      if (error instanceof ProductionBackupCommandError) {
        process.stderr.write(error.stderr);
        process.exitCode = error.exitCode;
      } else {
        const message = error instanceof Error ? error.message : "BACKUP_COMMAND_FAILED";
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      }
    }
  }
}
