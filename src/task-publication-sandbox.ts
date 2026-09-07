import { PinnedDirectory } from "./task-workspace-directory.js";

export type PublicationMount = { directory: PinnedDirectory; destination: string; writable: boolean };

/** Only object storage, the new-ref namespace and the private index receive writable mounts. */
export async function openPublicationWriteDirectories(common: PinnedDirectory): Promise<PinnedDirectory[]> {
  const handles: PinnedDirectory[] = [];
  try {
    handles.push(await common.child("objects", false, false));
    handles.push(await common.child("refs", false, false));
    handles.push(await handles[1]!.child("heads", false, false));
    const heads = handles[2]!;
    const refDirectory = await heads.child("codex", false, false).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return await heads.child("codex", true, false).catch(async createError => {
        if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
        return await heads.child("codex", false, false);
      });
    });
    handles.push(refDirectory);
    for (const handle of handles) await handle.check();
    return handles;
  } catch (error) { for (const handle of handles.reverse()) await handle.handle.close(); throw error; }
}

export function publicationSandboxArguments(mounts: readonly PublicationMount[], env: NodeJS.ProcessEnv, command: string[]): string[] {
  const args = ["--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--clearenv", "--ro-bind", "/usr/bin", "/usr/bin", "--ro-bind", "/usr/lib", "/usr/lib",
    "--ro-bind-try", "/usr/lib64", "/usr/lib64", "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--dir", "/workspace"];
  for (const [key, value] of Object.entries(env)) if (value !== undefined) args.push("--setenv", key, value);
  for (const [index, mount] of mounts.entries()) {
    args.push(mount.writable ? "--bind-fd" : "--ro-bind-fd", String(index + 3), mount.destination);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--remount-ro", "/", "--chdir", "/workspace", "--", ...command);
  return args;
}
