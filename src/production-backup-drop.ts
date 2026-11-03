// Root must not write the production backup. The directory is owned by jarvis-svc,
// and the backup accepts only a caller whose uid matches that owner.
// Tests inject execFile and stat. This does not widen the owner check.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const PRODUCTION_BACKUP_SERVICE = "jarvis-svc";

export type BackupExecFile = (file: string, args: readonly string[]) => Promise<string | void>;
export type BackupStat = (path: string) => { readonly uid: number; readonly mode: number };

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

export async function runProductionBackup(input: {
  readonly uid: number;
  readonly stateRoot: string;
  readonly command: readonly string[];
  readonly execFile?: BackupExecFile;
  readonly destPath?: string;
  readonly expectedUid?: number;
  readonly stat?: BackupStat;
}): Promise<{ readonly spec: { readonly file: string; readonly args: readonly string[] }; readonly stdout: string }> {
  const spec = productionBackupChild(input.uid, input.stateRoot, input.command);
  const stdout = await (input.execFile ?? defaultExecFile)(spec.file, spec.args);
  if (input.destPath !== undefined) {
    const info = (input.stat ?? defaultStat)(input.destPath);
    if ((info.mode & 0o777) !== 0o600 || info.uid !== input.expectedUid) throw new Error("BACKUP_FILE_OWNER");
  }
  return { spec, stdout: typeof stdout === "string" ? stdout : "" };
}

async function defaultExecFile(file: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, [...args], { encoding: "utf8" });
  return stdout;
}

function defaultStat(path: string): { readonly uid: number; readonly mode: number } {
  const info = statSync(path);
  return { uid: info.uid, mode: info.mode };
}

function callerIsMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (callerIsMain()) {
  const separator = process.argv.indexOf("--");
  const flagArgs = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator);
  const command = separator === -1 ? [] : process.argv.slice(separator + 1);
  let uid: number | undefined;
  let stateRoot = "";
  let usage = false;
  for (let index = 0; index < flagArgs.length; index += 2) {
    const flag = flagArgs[index];
    const value = flagArgs[index + 1];
    if (flag === "--uid" && value !== undefined && /^[0-9]+$/.test(value)) uid = Number(value);
    else if (flag === "--state-root") stateRoot = value ?? "";
    else usage = true;
  }
  if (usage || uid === undefined) {
    process.stderr.write("BACKUP_USAGE\n");
    process.exitCode = 2;
  } else {
    try {
      const { stdout } = await runProductionBackup({ uid, stateRoot, command });
      process.stdout.write(stdout);
    } catch {
      process.stderr.write("BACKUP_COMMAND_FAILED\n");
      process.exitCode = 1;
    }
  }
}
