import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { JarvisError } from "./db.js";
import { taskProcessTimeout } from "./task-process-boundary.js";
import type { TaskCandidateProvider, TaskProviderRequest } from "./task-candidate-provider.js";

export function claudeTaskArguments(input: TaskProviderRequest): string[] {
  return ["-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--disallowedTools", "mcp__*",
    "--disable-slash-commands", "--no-session-persistence", "--setting-sources", "", "--permission-mode", "dontAsk",
    "--output-format", "json", "--json-schema", JSON.stringify(input.output_schema), "--max-turns", "3"];
}

/** Trusted installed CLI. Model tools are disabled; API transport still uses the operator's Claude authentication. */
export class ClaudeTaskCandidateProvider implements TaskCandidateProvider {
  readonly provider = "claude" as const;
  constructor(private readonly executable: string) {}

  async generate(input: TaskProviderRequest): Promise<{ output: unknown; output_bytes: number }> {
    const deadline = performance.now() + input.timeout_ms;
    if (input.provider !== this.provider || !isAbsolute(this.executable)) throw new JarvisError("TASK_PROVIDER_UNAVAILABLE");
    if (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms < 1 || input.timeout_ms > 600_000
      || !Number.isSafeInteger(input.max_output_bytes) || input.max_output_bytes < 1 || input.max_output_bytes > 1_048_576
      || Buffer.byteLength(input.prompt) > 512 * 1024) throw new JarvisError("TASK_PROVIDER_INPUT_INVALID");
    let executable: string;
    try {
      executable = await realpath(this.executable);
      const info = await stat(executable);
      if (!info.isFile() || (info.mode & 0o022) !== 0) throw new Error("invalid executable");
    } catch { throw new JarvisError("TASK_PROVIDER_UNAVAILABLE"); }
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["HOME", "PATH", "LANG", "TZ"]) if (process.env[key] !== undefined) env[key] = process.env[key];
    const args = claudeTaskArguments(input);
    return await new Promise<{ output: unknown; output_bytes: number }>((resolve, reject) => {
      const timeout = taskProcessTimeout(deadline, input.before_spawn, "TASK_PROVIDER_TIMEOUT");
      const child = spawn(executable, args, {
        cwd: "/", env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
      let bytes = 0;
      const stdout: Buffer[] = [];
      let failure: string | undefined;
      const stop = (code: string) => {
        failure ??= code;
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      };
      const timer = setTimeout(() => stop("TASK_PROVIDER_TIMEOUT"), timeout);
      const take = (chunk: Buffer, capture: boolean) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > input.max_output_bytes) stop("TASK_PROVIDER_OUTPUT_LIMIT");
        else if (capture) stdout.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => take(chunk, true));
      child.stderr.on("data", (chunk: Buffer) => take(chunk, false));
      child.stdin.on("error", () => stop("TASK_PROVIDER_INPUT_FAILED"));
      child.on("error", () => { failure ??= "TASK_PROVIDER_UNAVAILABLE"; });
      child.on("close", code => {
        clearTimeout(timer);
        if (failure) { reject(new JarvisError(failure)); return; }
        if (code !== 0) { reject(new JarvisError("TASK_PROVIDER_FAILED")); return; }
        try {
          const result = JSON.parse(Buffer.concat(stdout).toString("utf8")) as Record<string, unknown>;
          if (!result || result.type !== "result" || result.subtype !== "success" || result.is_error !== false
            || result.structured_output === undefined) throw new Error("invalid result");
          resolve({ output: result.structured_output, output_bytes: bytes });
        } catch { reject(new JarvisError("TASK_PROVIDER_RESULT_INVALID")); }
      });
      child.stdin.end(input.prompt);
    });
  }
}
