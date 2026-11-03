// Root must not write the production backup. The directory is owned by jarvis-svc,
// and the backup accepts only a caller whose uid matches that owner.
// Tests inject execFile and stat. This does not widen the owner check.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const PRODUCTION_BACKUP_SERVICE = "jarvis-svc";

export function productionBackupChild(uid, stateRoot, command) {
  if (!Array.isArray(command) || command.length === 0 || typeof command[0] !== "string" || command[0] === "") {
    throw new Error("BACKUP_COMMAND");
  }
  if (uid !== 0) return { file: command[0], args: command.slice(1) };
  if (typeof stateRoot !== "string" || !stateRoot.startsWith("/")) throw new Error("BACKUP_STATE_ROOT");
  return {
    file: "/usr/bin/sudo",
    args: ["-n", "-u", PRODUCTION_BACKUP_SERVICE, "--", "/usr/bin/env", `JARVIS_STATE_ROOT=${stateRoot}`, ...command],
  };
}

export async function runProductionBackup({
  uid,
  stateRoot,
  command,
  execFile: run = defaultExecFile,
  destPath,
  expectedUid,
  stat = statSync,
}) {
  const spec = productionBackupChild(uid, stateRoot, command);
  const stdout = await run(spec.file, spec.args);
  if (destPath !== undefined) {
    const info = stat(destPath);
    if ((info.mode & 0o777) !== 0o600 || info.uid !== expectedUid) throw new Error("BACKUP_FILE_OWNER");
  }
  return { spec, stdout: typeof stdout === "string" ? stdout : "" };
}

async function defaultExecFile(file, args) {
  const { stdout } = await execFileAsync(file, [...args], { encoding: "utf8" });
  return stdout;
}

function callerIsMain() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (callerIsMain()) {
  const separator = process.argv.indexOf("--");
  const flagArgs = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator);
  const command = separator === -1 ? [] : process.argv.slice(separator + 1);
  let uid;
  let stateRoot = "";
  for (let index = 0; index < flagArgs.length; index += 2) {
    const flag = flagArgs[index];
    const value = flagArgs[index + 1];
    if (flag === "--uid") uid = Number(value);
    else if (flag === "--state-root") stateRoot = value ?? "";
    else process.exitCode = 2;
  }
  if (process.exitCode === 2 || !Number.isInteger(uid)) {
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
