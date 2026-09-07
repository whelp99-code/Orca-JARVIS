import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { Writable } from "node:stream";
import { JarvisError } from "./db.js";

export type TaskSandboxFile = { readonly path: string; readonly content: Buffer };
export type TaskSandboxInvocation = {
  readonly argv: readonly string[]; readonly cwd: string; readonly files: readonly TaskSandboxFile[];
  readonly timeout_ms: number; readonly max_output_bytes: number;
};
export type TaskSandboxResult = {
  readonly exit_code: number; readonly stdout_bytes: number; readonly stderr_bytes: number;
  readonly stdout_digest: string; readonly stderr_digest: string;
};
export type TaskSandboxRunner = (input: TaskSandboxInvocation) => Promise<TaskSandboxResult>;

/** Internal argv builder: paths and argv have already been validated against the signed plan. */
export function taskSandboxArguments(input: TaskSandboxInvocation): string[] {
  const args = ["--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--clearenv", "--setenv", "PATH", "/runtime:/usr/bin:/bin", "--setenv", "HOME", "/home/agent",
    "--setenv", "TMPDIR", "/tmp", "--setenv", "LANG", "C.UTF-8",
    "--ro-bind", "/usr/bin", "/usr/bin", "--ro-bind", "/usr/lib", "/usr/lib",
    "--ro-bind-try", "/usr/lib64", "/usr/lib64", "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--size", "67108864", "--tmpfs", "/tmp",
    "--dir", "/home/agent", "--dir", "/runtime", "--ro-bind-fd", "3", "/runtime/node", "--dir", "/workspace"];
  for (const [index, file] of input.files.entries()) {
    args.push("--perms", "0400", "--ro-bind-data", String(index + 4), `/workspace/${file.path}`);
  }
  args.push("--remount-ro", "/", "--chdir", input.cwd === "." ? "/workspace" : `/workspace/${input.cwd}`,
    "--", ...input.argv);
  return args;
}

/** No host workspaces, credentials, inherited environment, network, or mutable candidate mounts. */
export const spawnTaskSandbox: TaskSandboxRunner = async input => {
  if (process.platform !== "linux") throw new JarvisError("TASK_SANDBOX_PLATFORM_UNAVAILABLE");
  const executable = await open(await realpath(process.execPath), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await new Promise<TaskSandboxResult>((resolve, reject) => {
      const child = spawn("/usr/bin/bwrap", taskSandboxArguments(input), {
        shell: false, cwd: "/", env: {}, detached: true,
        stdio: ["ignore", "pipe", "pipe", executable.fd, ...input.files.map(() => "pipe" as const)],
      });
      const stdout = createHash("sha256"), stderr = createHash("sha256");
      let stdoutBytes = 0, stderrBytes = 0;
      let failure: string | undefined;
      const stop = (code: string) => {
        failure ??= code;
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      };
      const timer = setTimeout(() => stop("TASK_SANDBOX_TIMEOUT"), input.timeout_ms);
      child.on("error", () => { failure ??= "TASK_SANDBOX_UNAVAILABLE"; });
      child.stdout!.on("data", (bytes: Buffer) => {
        if (failure) return;
        stdoutBytes += bytes.length;
        if (stdoutBytes + stderrBytes > input.max_output_bytes) stop("TASK_SANDBOX_OUTPUT_LIMIT");
        else stdout.update(bytes);
      });
      child.stderr!.on("data", (bytes: Buffer) => {
        if (failure) return;
        stderrBytes += bytes.length;
        if (stdoutBytes + stderrBytes > input.max_output_bytes) stop("TASK_SANDBOX_OUTPUT_LIMIT");
        else stderr.update(bytes);
      });
      child.on("close", code => {
        clearTimeout(timer);
        if (failure) reject(new JarvisError(failure));
        else resolve({ exit_code: code ?? -1, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes,
          stdout_digest: `sha256:${stdout.digest("hex")}`, stderr_digest: `sha256:${stderr.digest("hex")}` });
      });
      for (const [index, file] of input.files.entries()) {
        const pipe = child.stdio[index + 4] as Writable;
        pipe.on("error", () => stop("TASK_SANDBOX_INPUT_FAILED"));
        pipe.end(file.content);
      }
    });
  } finally { await executable.close(); }
};
