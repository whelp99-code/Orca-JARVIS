import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { JarvisError } from "./db.js";
import type { TaskExecutionPlan } from "./task-execution-plan.js";

const FILE_LIMIT = 4 * 1024 * 1024;
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fail = (code: string): never => { throw new JarvisError(code); };
export type CapturedFile = { path: string; access: "read" | "write"; digest: string | null; bytes: number;
  executable: boolean; content: Buffer | null };

/** Linux descriptor-relative traversal keeps parent symlinks out of selected file reads. */
export class PinnedDirectory {
  private constructor(readonly path: string, readonly handle: FileHandle, private readonly device: number,
    private readonly inode: number) {}
  static async open(path: string, privateDirectory = false): Promise<PinnedDirectory> {
    if (process.platform !== "linux") return fail("TASK_WORKSPACE_PLATFORM_UNAVAILABLE");
    if (await realpath(path) !== path) return fail("TASK_REPOSITORY_PATH_INVALID");
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (privateDirectory && (stat.mode & 0o077) !== 0)) {
        return fail(privateDirectory ? "TASK_WORKSPACE_PARENT_INVALID" : "TASK_REPOSITORY_PATH_INVALID");
      }
      return new PinnedDirectory(path, handle, stat.dev, stat.ino);
    } catch (error) { await handle.close(); throw error; }
  }
  get anchored(): string { return `/proc/${process.pid}/fd/${this.handle.fd}`; }
  async child(name: string, create = false, privateDirectory = true): Promise<PinnedDirectory> {
    await this.check();
    if (create) await mkdir(join(this.anchored, name), { mode: 0o700 });
    const handle = await open(join(this.anchored, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      const path = join(this.path, name);
      if (stat.uid !== process.getuid?.() || (privateDirectory && (stat.mode & 0o077) !== 0)
        || await realpath(`/proc/${process.pid}/fd/${handle.fd}`) !== path) return fail("TASK_WORKSPACE_PARENT_INVALID");
      return new PinnedDirectory(path, handle, stat.dev, stat.ino);
    } catch (error) { await handle.close(); throw error; }
  }
  async write(name: string, file: CapturedFile): Promise<void> {
    if (file.content === null) return;
    await this.check();
    const output = await open(join(this.anchored, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      (file.access === "write" ? 0o600 : 0o400) | (file.executable ? 0o100 : 0));
    try {
      await output.writeFile(file.content);
      await output.sync();
      if (await realpath(`/proc/${process.pid}/fd/${output.fd}`) !== join(this.path, name)) {
        return fail("TASK_REPOSITORY_CHANGED");
      }
    } finally { await output.close(); }
    await this.check();
  }
  async check(): Promise<void> {
    const stat = await lstat(this.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.device || stat.ino !== this.inode
      || await realpath(this.anchored) !== this.path) return fail("TASK_REPOSITORY_CHANGED");
  }
  async read(file: TaskExecutionPlan["files"][number]): Promise<CapturedFile> {
    const parents: FileHandle[] = [];
    let current = this.handle;
    const parts = file.path.split("/");
    let opened: FileHandle | undefined;
    try {
      for (const part of parts.slice(0, -1)) {
        current = await open(`/proc/${process.pid}/fd/${current.fd}/${part}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        parents.push(current);
      }
      opened = await open(`/proc/${process.pid}/fd/${current.fd}/${parts.at(-1)}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await opened.stat();
      if (!before.isFile() || before.nlink !== 1 || before.dev !== this.device || before.uid !== process.getuid?.()) {
        return fail("TASK_REPOSITORY_FILE_INVALID");
      }
      if (file.before_digest === null) return fail("TASK_REPOSITORY_FILE_CHANGED");
      if (before.size > FILE_LIMIT) return fail("TASK_REPOSITORY_INPUT_OVERSIZE");
      const buffer = Buffer.alloc(before.size + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await opened.read(buffer, bytes, buffer.length - bytes, bytes);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
      }
      const after = await opened.stat();
      if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || await realpath(`/proc/${process.pid}/fd/${opened.fd}`) !== join(this.path, file.path)) {
        return fail("TASK_REPOSITORY_CHANGED");
      }
      const content = buffer.subarray(0, bytes);
      if (hash(content) !== file.before_digest) return fail("TASK_REPOSITORY_FILE_CHANGED");
      return { path: file.path, access: file.access, digest: file.before_digest, bytes,
        executable: Boolean(before.mode & 0o111), content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && file.before_digest === null) {
        return { path: file.path, access: file.access, digest: null, bytes: 0, executable: false, content: null };
      }
      if (error instanceof JarvisError) throw error;
      return fail("TASK_REPOSITORY_FILE_INVALID");
    } finally {
      await opened?.close();
      for (const parent of parents.reverse()) await parent.close();
    }
  }
}
