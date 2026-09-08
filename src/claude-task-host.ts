import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { JarvisError } from "./db.js";

export async function resolveClaudeTaskExecutable(path: string): Promise<string> {
  try {
    if (!isAbsolute(path)) throw new Error("absolute path required");
    const executable = await realpath(path); const info = await stat(executable);
    if (!info.isFile() || (info.mode & 0o022) !== 0) throw new Error("invalid executable");
    await access(executable, constants.X_OK);
    return executable;
  } catch { throw new JarvisError("TASK_PROVIDER_UNAVAILABLE"); }
}

/** Keep status inspection and generation in the same restricted host environment. */
export function claudeTaskEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "LANG", "TZ"]) if (source[key] !== undefined) env[key] = source[key];
  return env;
}
