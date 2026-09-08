import { TaskProviderFailure } from "./task-provider-failure.js";
import { readClaudeTaskUsage } from "./claude-task-usage.js";
import { TASK_PROVIDER_LIMITS } from "./task-execution-limits.js";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { JarvisError } from "./db.js";
import { taskProcessTimeout } from "./task-process-boundary.js";
import type { TaskCandidateProvider, TaskProviderRequest, TaskProviderResult } from "./task-candidate-provider.js";
import { resolveClaudeTaskExecutable, claudeTaskEnvironment } from "./claude-task-host.js";

export function claudeTaskArguments(input: TaskProviderRequest): string[] {
  return ["-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--disallowedTools", "mcp__*",
    "--disable-slash-commands", "--no-session-persistence", "--setting-sources", "", "--permission-mode", "dontAsk",
    "--output-format", "json", "--json-schema", JSON.stringify(input.output_schema), "--max-turns", "3"];
}

/** Trusted installed CLI. Model tools are disabled; API transport still uses the operator's Claude authentication. */
export class ClaudeTaskCandidateProvider implements TaskCandidateProvider {
  readonly provider = "claude" as const;
  constructor(private readonly executable: string) {}

  async checkReady(): Promise<void> { await resolveClaudeTaskExecutable(this.executable); }

  async generate(input: TaskProviderRequest): Promise<TaskProviderResult> {
    const deadline = performance.now() + input.timeout_ms;
    if (input.provider !== this.provider || !isAbsolute(this.executable)) throw new JarvisError("TASK_PROVIDER_UNAVAILABLE");
    if (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms < TASK_PROVIDER_LIMITS.min_timeout_ms
      || input.timeout_ms > TASK_PROVIDER_LIMITS.max_timeout_ms || !Number.isSafeInteger(input.max_output_bytes)
      || input.max_output_bytes < TASK_PROVIDER_LIMITS.min_output_bytes || input.max_output_bytes > TASK_PROVIDER_LIMITS.max_output_bytes
      || Buffer.byteLength(input.prompt) > TASK_PROVIDER_LIMITS.max_prompt_bytes) throw new JarvisError("TASK_PROVIDER_INPUT_INVALID");
    const executable = await resolveClaudeTaskExecutable(this.executable);
    const env = claudeTaskEnvironment(process.env);
    const args = claudeTaskArguments(input);
    return await new Promise<TaskProviderResult>((resolve, reject) => {
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
        if (code === null) { reject(new JarvisError("TASK_PROVIDER_FAILED")); return; }
        try {
          const raw = Buffer.concat(stdout), text = raw.toString("utf8");
          if (!Buffer.from(text, "utf8").equals(raw)) throw new Error("invalid UTF-8");
          const result = JSON.parse(text) as Record<string, unknown>;
          const success = result?.subtype === "success" && result.is_error === false;
          const failed = result?.is_error === true && ["error_during_execution", "error_max_turns",
            "error_max_budget_usd", "error_max_structured_output_retries"].includes(result.subtype as string);
          if (!result || Array.isArray(result) || result.type !== "result" || (!success && !failed)) throw new Error("invalid result");
          const usage = readClaudeTaskUsage(result);
          if (code !== 0 || !success || result.structured_output === undefined) {
            reject(new TaskProviderFailure(code !== 0 ? "TASK_PROVIDER_FAILED" : "TASK_PROVIDER_RESULT_INVALID", usage));
            return;
          }
          resolve({ output: result.structured_output, output_bytes: bytes, usage });
        } catch { reject(new JarvisError(code !== 0 ? "TASK_PROVIDER_FAILED" : "TASK_PROVIDER_RESULT_INVALID")); }
      });
      child.stdin.end(input.prompt);
    });
  }
}
