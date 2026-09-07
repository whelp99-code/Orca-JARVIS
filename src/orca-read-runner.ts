import { spawn } from "node:child_process";
import { JarvisError } from "./db.js";
import { decodeOrcaReadOutput, ORCA_READ_MAX_BYTES, parseOrcaReadPayload } from "./orca-read-envelope.js";

const MAX_TIMEOUT_MS = 5_000;
const CLOSE_GRACE_MS = 250;

export function resolveOrcaReadExecutable(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
): string {
  const executable = environment.ORCA_CLI_COMMAND
    ?? (environment.ORCA_DEV_REPO_ROOT ? "orca-dev" : platform === "linux" ? "orca-ide" : "orca");
  if (!executable.trim() || executable !== executable.trim() || /[\0\r\n]/u.test(executable)) {
    throw new JarvisError("ORCA_CLI_CONFIG_INVALID");
  }
  return executable;
}

function startFailure(error: NodeJS.ErrnoException): JarvisError {
  if (error.code === "ENOENT") return new JarvisError("ORCA_CLI_NOT_INSTALLED");
  if (error.code === "EACCES" || error.code === "EPERM") return new JarvisError("ORCA_PERMISSION_DENIED");
  return new JarvisError("ORCA_CLI_FAILED");
}

function spawnReadChild(executable: string, args: readonly string[], grouped: boolean) {
  try {
    return spawn(executable, [...args], { shell: false, windowsHide: true,
      detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) { throw startFailure(error as NodeJS.ErrnoException); }
}

export function createOrcaReadRunner(options: { executable?: string; timeoutMs?: number } = {}):
  (args: readonly string[]) => Promise<string> {
  const executable = options.executable === undefined ? resolveOrcaReadExecutable()
    : resolveOrcaReadExecutable({ ORCA_CLI_COMMAND: options.executable });
  const timeout = options.timeoutMs ?? MAX_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) throw new JarvisError("ORCA_CLI_CONFIG_INVALID");
  // An unconfirmed child close poisons this runner; repeated calls must not leak more children.
  let cleanupFailed = false;
  return async args => {
    if (cleanupFailed) throw new JarvisError("ORCA_CLI_CLEANUP_FAILED");
    return new Promise<string>((resolve, reject) => {
      const grouped = process.platform !== "win32";
      const child = spawnReadChild(executable, args, grouped);
      const output: Buffer[] = [];
      let bytes = 0;
      let failure: JarvisError | undefined;
      let closed = false;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (error: JarvisError): void => {
        if (closed || failure) return;
        failure = error;
        clearTimeout(timer);
        if (child.pid !== undefined) {
          try {
            if (grouped) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch (caught) {
            if ((caught as NodeJS.ErrnoException).code !== "ESRCH") {
              failure = new JarvisError("ORCA_CLI_CLEANUP_FAILED"); cleanupFailed = true;
            }
          }
        }
        closeTimer = setTimeout(() => {
          cleanupFailed = true;
          child.stdout.destroy(); child.stderr.destroy(); child.unref();
          reject(new JarvisError("ORCA_CLI_CLEANUP_FAILED"));
        }, CLOSE_GRACE_MS);
      };
      const timer = setTimeout(() => stop(new JarvisError("ORCA_CLI_TIMEOUT")), timeout);
      const take = (chunk: Buffer, capture: boolean): void => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > ORCA_READ_MAX_BYTES) stop(new JarvisError("ORCA_CLI_OUTPUT_LIMIT"));
        else if (capture) output.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => take(chunk, true));
      child.stderr.on("data", (chunk: Buffer) => take(chunk, false));
      child.stdout.on("error", () => stop(new JarvisError("ORCA_CLI_FAILED")));
      child.stderr.on("error", () => stop(new JarvisError("ORCA_CLI_FAILED")));
      child.on("error", error => stop(startFailure(error)));
      child.once("close", (code, signal) => {
        closed = true;
        clearTimeout(timer); if (closeTimer) clearTimeout(closeTimer);
        // Descendants with detached stdio do not delay close; terminate the owned group too.
        if (grouped && child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (caught) {
            if ((caught as NodeJS.ErrnoException).code !== "ESRCH") {
              cleanupFailed = true; failure = new JarvisError("ORCA_CLI_CLEANUP_FAILED");
            }
          }
        }
        if (failure) { reject(failure); return; }
        if (signal !== null) { reject(new JarvisError("ORCA_CLI_FAILED")); return; }
        try {
          const text = decodeOrcaReadOutput(Buffer.concat(output));
          if (code !== 0) {
            // Real Orca CLI exits 1 for structured rejections; stderr prose is not a protocol.
            parseOrcaReadPayload(text);
            throw new JarvisError("ORCA_CLI_EXIT_INVALID");
          }
          resolve(text);
        } catch (error) { reject(error); }
      });
    });
  };
}
