import { spawn } from "node:child_process";
import { parseBoundedStrictJson } from "./strict-json.js";
import { claudeTaskEnvironment, resolveClaudeTaskExecutable } from "./claude-task-host.js";

export const CLAUDE_AUTH_PROBE_LIMITS = Object.freeze({ timeout_ms: 5000, max_output_bytes: 32768 });
type State = "reported_logged_in" | "reported_logged_out" | "unknown" | "not_probed";
export type TaskAuthenticationObservation = { state: State; remote_verification: "not_performed"; reason_code?: string };
const observation = (state: State, reason_code?: string): TaskAuthenticationObservation =>
  ({ state, remote_verification: "not_performed", ...(reason_code ? { reason_code } : {}) });

/** Explicit local CLI status query, not an API authentication test or authority grant. Never expose raw output. */
export async function probeClaudeTaskAuthentication(env: NodeJS.ProcessEnv): Promise<TaskAuthenticationObservation> {
  const path = env.JARVIS_TASK_CLAUDE_PATH;
  if (!path) return observation("not_probed", "TASK_AUTH_PROBE_NOT_CONFIGURED");
  const deadline = performance.now() + CLAUDE_AUTH_PROBE_LIMITS.timeout_ms;
  let executable: string;
  try { executable = await resolveClaudeTaskExecutable(path); }
  catch { return observation("unknown", "TASK_AUTH_PROBE_UNAVAILABLE"); }
  const timeout = Math.floor(deadline - performance.now());
  if (timeout < 1) return observation("unknown", "TASK_AUTH_PROBE_TIMEOUT");
  return await new Promise<TaskAuthenticationObservation>(resolve => {
    const child = spawn(executable, ["auth", "status", "--json"], { cwd: "/", env: claudeTaskEnvironment(env),
      shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; let bytes = 0; let failure: string | undefined;
    const stop = (code: string) => {
      failure ??= code;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const timer = setTimeout(() => stop("TASK_AUTH_PROBE_TIMEOUT"), timeout);
    const take = (chunk: Buffer, capture: boolean) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > CLAUDE_AUTH_PROBE_LIMITS.max_output_bytes) stop("TASK_AUTH_PROBE_OUTPUT_LIMIT");
      else if (capture) stdout.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => take(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => take(chunk, false));
    child.on("error", () => { failure ??= "TASK_AUTH_PROBE_UNAVAILABLE"; });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) { resolve(observation("unknown", failure)); return; }
      try {
        const raw = Buffer.concat(stdout), text = raw.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(raw)) throw new Error("invalid");
        const value = parseBoundedStrictJson(text, { depth: 8, nodes: 256, workItems: 1024, characters: 32768 });
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
        const loggedIn = Reflect.get(value, "loggedIn");
        if (loggedIn === true && code === 0) resolve(observation("reported_logged_in"));
        else if (loggedIn === false && code === 1) resolve(observation("reported_logged_out"));
        else resolve(observation("unknown", "TASK_AUTH_PROBE_RESULT_INVALID"));
      } catch { resolve(observation("unknown", "TASK_AUTH_PROBE_RESULT_INVALID")); }
    });
  }).catch(() => observation("unknown", "TASK_AUTH_PROBE_UNAVAILABLE"));
}
