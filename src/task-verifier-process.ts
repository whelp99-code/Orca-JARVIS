import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { JarvisError } from "./db.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import { taskProcessTimeout } from "./task-process-boundary.js";

export type TaskVerifierInvocation = { readonly database: string; readonly command: ClaimedControlCommand;
  readonly verification_id: string; readonly timeout_ms: number; readonly before_spawn: () => number };
export interface TaskVerifierProcess {
  checkReady(): Promise<void>;
  verify(input: TaskVerifierInvocation): Promise<unknown>;
}
const INPUT_LIMIT = 4 * 1024 * 1024;
const OUTPUT_LIMIT = 524288 + 4096; // Signed metadata plus bounded diagnostics; checker output has its own shared plan budget.

/** Trusted installed verifier entry. The parent passes a key path and never loads private key bytes. */
export class NodeTaskVerifierProcess implements TaskVerifierProcess {
  private readonly entry = fileURLToPath(new URL("./task-verifier-main.js", import.meta.url));
  constructor(private readonly keyPath: string) {}

  private async paths() {
    try {
      const executable = await realpath(process.execPath);
      for (const path of [executable, this.entry, this.keyPath]) {
        if (!isAbsolute(path) || await realpath(path) !== path) throw new Error("noncanonical path");
        const info = await stat(path);
        if (!info.isFile() || (info.mode & 0o022) !== 0) throw new Error("untrusted file");
        if (path === this.keyPath && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0
          || info.nlink !== 1 || info.size < 1 || info.size > 16384)) throw new Error("invalid private key file");
      }
      return executable;
    } catch { throw new JarvisError("TASK_VERIFIER_UNAVAILABLE"); }
  }

  async checkReady(): Promise<void> { await this.paths(); }

  async verify(input: TaskVerifierInvocation): Promise<unknown> {
    const deadline = performance.now() + input.timeout_ms;
    if (!isAbsolute(input.database) || !Number.isSafeInteger(input.timeout_ms) || input.timeout_ms < 1
      || input.timeout_ms > 600000 || typeof input.verification_id !== "string" || typeof input.before_spawn !== "function") {
      throw new JarvisError("TASK_VERIFIER_INPUT_INVALID");
    }
    const payload = JSON.stringify({ command: input.command, verification_id: input.verification_id });
    if (Buffer.byteLength(payload) > INPUT_LIMIT) throw new JarvisError("TASK_VERIFIER_INPUT_INVALID");
    const executable = await this.paths();
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = taskProcessTimeout(deadline, input.before_spawn, "TASK_VERIFIER_TIMEOUT");
      const child = spawn(executable, [this.entry, input.database, this.keyPath], {
        cwd: "/", env: {}, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = []; let bytes = 0; let failure: string | undefined;
      const stop = (code: string) => {
        failure ??= code;
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      };
      const timer = setTimeout(() => stop("TASK_VERIFIER_TIMEOUT"), timeout);
      const take = (chunk: Buffer, capture: boolean) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > OUTPUT_LIMIT) stop("TASK_VERIFIER_OUTPUT_LIMIT");
        else if (capture) stdout.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => take(chunk, true));
      child.stderr.on("data", (chunk: Buffer) => take(chunk, false));
      child.stdin.on("error", () => stop("TASK_VERIFIER_INPUT_FAILED"));
      child.on("error", () => { failure ??= "TASK_VERIFIER_UNAVAILABLE"; });
      child.on("close", code => {
        clearTimeout(timer);
        if (failure) { reject(new JarvisError(failure)); return; }
        if (code !== 0) { reject(new JarvisError("TASK_VERIFIER_FAILED")); return; }
        try { resolve(JSON.parse(Buffer.concat(stdout).toString("utf8"))); }
        catch { reject(new JarvisError("TASK_VERIFIER_RESULT_INVALID")); }
      });
      child.stdin.end(payload);
    });
  }
}
