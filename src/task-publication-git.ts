import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, mkdtemp, unlink, rmdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JarvisError } from "./db.js";
import { PinnedDirectory } from "./task-workspace-directory.js";
import { canonicalize } from "./canonical.js";
import { openPublicationWriteDirectories, publicationSandboxArguments, type PublicationMount } from "./task-publication-sandbox.js";

const candidateHash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const GIT_ARGS = ["--no-replace-objects", "--no-lazy-fetch", "--literal-pathspecs",
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false",
  "-c", "core.splitIndex=false", "-c", "core.sparseCheckout=false", "-c", "gc.auto=0", "-c", "core.logAllRefUpdates=false"];
const environment = (): NodeJS.ProcessEnv => ({ PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "JARVIS", GIT_AUTHOR_EMAIL: "jarvis@example.invalid",
  GIT_COMMITTER_NAME: "JARVIS", GIT_COMMITTER_EMAIL: "jarvis@example.invalid" });

async function git(root: string, args: string[], env: NodeJS.ProcessEnv, check: () => number,
  input: Buffer = Buffer.alloc(0), limit = 262144, exits: readonly number[] = [0], mounts?: readonly PublicationMount[]): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const remaining = check();
    if (!Number.isSafeInteger(remaining) || remaining < 1) throw new JarvisError("TASK_PUBLICATION_DEADLINE_EXCEEDED");
    const command = ["/usr/bin/git", ...GIT_ARGS, "-C", root, ...args];
    const child = spawn(mounts ? "/usr/bin/bwrap" : command[0]!, mounts ? publicationSandboxArguments(mounts, env, command) : command.slice(1), {
      env: mounts ? {} : env, cwd: "/", shell: false, detached: true,
      stdio: [input.length === 0 ? "ignore" : "pipe", "pipe", "pipe", ...(mounts?.map(mount => mount.directory.handle.fd) ?? [])],
    });
    const chunks: Buffer[] = []; let size = 0; let failure: string | undefined;
    const stop = (code: string) => {
      failure ??= code;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const timer = setTimeout(() => stop("TASK_PUBLICATION_GIT_TIMEOUT"), Math.min(remaining, 10000));
    const take = (chunk: Buffer, capture: boolean) => {
      if (failure) return;
      size += chunk.length;
      if (size > limit) stop("TASK_PUBLICATION_GIT_OUTPUT_LIMIT"); else if (capture) chunks.push(chunk);
    };
    child.stdout!.on("data", (chunk: Buffer) => take(chunk, true));
    child.stderr!.on("data", (chunk: Buffer) => take(chunk, false));
    child.stdin?.on("error", () => stop("TASK_PUBLICATION_GIT_INPUT_FAILED"));
    child.on("error", () => { failure ??= "TASK_PUBLICATION_GIT_UNAVAILABLE"; });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure || code === null || !exits.includes(code)) reject(new JarvisError(failure ?? "TASK_PUBLICATION_GIT_FAILED"));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin?.end(input);
  });
}

async function locator(path: string): Promise<string> {
  try {
    const before = await lstat(path);
    if (before.isDirectory()) return `directory:${before.dev}:${before.ino}`;
    if (!before.isFile() || before.nlink !== 1 || before.size > 4096) throw new JarvisError("TASK_PUBLICATION_GIT_IDENTITY_INVALID");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await file.stat(); const bytes = Buffer.alloc(before.size + 1);
      if (!opened.isFile() || before.ino !== opened.ino || before.dev !== opened.dev) {
        throw new JarvisError("TASK_PUBLICATION_GIT_IDENTITY_INVALID");
      }
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, length);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      const after = await lstat(path);
      if (before.ino !== after.ino || before.dev !== after.dev || before.ctimeMs !== after.ctimeMs || length !== before.size) {
        throw new JarvisError("TASK_PUBLICATION_GIT_IDENTITY_INVALID");
      }
      return `file:${before.dev}:${before.ino}:${candidateHash(bytes.subarray(0, length))}`;
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

/** Fixed repository descriptors and a private index; all calls retain the caller's current authority/deadline check. */
export class TaskPublicationGit {
  private constructor(private readonly root: PinnedDirectory, private readonly gitDir: PinnedDirectory,
    private readonly common: PinnedDirectory, private readonly index: PinnedDirectory | null,
    private readonly locators: readonly [string, string][], private readonly checkAuthority: () => number, readonly createdAt: string,
    readonly identity: string, private readonly writes: readonly PinnedDirectory[]) {}

  static async open(rootPath: string, check: () => number, createdAt: string, readOnly = false,
    expectedIdentity?: string): Promise<TaskPublicationGit> {
    const handles: PinnedDirectory[] = [];
    try {
      const root = await PinnedDirectory.open(rootPath); handles.push(root);
      const gitPointer = join(root.anchored, ".git"); const first = await locator(gitPointer);
      const discovered = (await git(root.anchored, ["rev-parse", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"],
        environment(), check)).toString("utf8").trimEnd().split("\n");
      if (discovered.length !== 2 || !discovered[0] || !discovered[1]) throw new JarvisError("TASK_PUBLICATION_GIT_IDENTITY_INVALID");
      const gitDir = await PinnedDirectory.open(discovered[0]); handles.push(gitDir);
      const commonPointer = join(gitDir.anchored, "commondir"); const second = await locator(commonPointer);
      const common = await PinnedDirectory.open(discovered[1]); handles.push(common);
      const identities = [];
      for (const directory of [root, gitDir, common]) {
        const stat = await directory.handle.stat({ bigint: true });
        identities.push({ path: directory.path, device: String(stat.dev), inode: String(stat.ino) });
      }
      const identity = candidateHash(canonicalize(identities));
      if (expectedIdentity !== undefined && identity !== expectedIdentity) throw new JarvisError("TASK_PUBLICATION_GIT_IDENTITY_CHANGED");
      const writes = readOnly ? [] : await openPublicationWriteDirectories(common); handles.push(...writes);
      const index = readOnly ? null : await PinnedDirectory.open(await mkdtemp(join(tmpdir(), "jarvis-publication-index-")), true);
      if (index) handles.push(index);
      const result = new TaskPublicationGit(root, gitDir, common, index, [[gitPointer, first], [commonPointer, second]],
        check, createdAt, identity, writes);
      await result.check();
      const confirmed = (await git(root.anchored, ["rev-parse", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"],
        environment(), check)).toString("utf8").trimEnd().split("\n");
      if (confirmed.join("\n") !== discovered.join("\n")) throw new JarvisError("TASK_PUBLICATION_GIT_IDENTITY_CHANGED");
      return result;
    } catch (error) {
      for (const handle of handles.reverse()) await handle.handle.close();
      if (error instanceof JarvisError) throw error;
      throw new JarvisError("TASK_PUBLICATION_GIT_IDENTITY_INVALID");
    }
  }

  private async check(): Promise<void> {
    for (const directory of [this.root, this.gitDir, this.common, ...this.writes, ...(this.index ? [this.index] : [])]) await directory.check();
    for (const [path, expected] of this.locators) if (await locator(path) !== expected) {
      throw new JarvisError("TASK_PUBLICATION_GIT_IDENTITY_CHANGED");
    }
  }

  async run(args: string[], input: Buffer = Buffer.alloc(0), outputLimit?: number, exits?: readonly number[]): Promise<Buffer> {
    if (!this.index && !(args.length === 3 && ((args[0] === "for-each-ref" && args[1] === "--format=%(refname)%00%(objectname)%00%(symref)")
      || (args[0] === "symbolic-ref" && args[1] === "-q")) && args[2]!.startsWith("refs/heads/codex/") && input.length === 0)) {
      throw new JarvisError("TASK_PUBLICATION_READ_ONLY");
    }
    await this.check();
    const mounts: PublicationMount[] = [{ directory: this.gitDir, destination: "/git", writable: false },
      { directory: this.common, destination: "/common", writable: false }];
    if (this.index) mounts.push({ directory: this.writes[0]!, destination: "/objects", writable: true },
      { directory: this.writes[3]!, destination: "/common/refs/heads/codex", writable: true },
      { directory: this.index, destination: "/index", writable: true });
    if (this.index && this.gitDir.path === this.common.path) {
      mounts.push({ directory: this.writes[3]!, destination: "/git/refs/heads/codex", writable: true });
    }
    const result = await git("/workspace", args, { ...environment(), GIT_DIR: "/git",
      GIT_COMMON_DIR: "/common", GIT_WORK_TREE: "/workspace",
      ...(this.index ? { GIT_INDEX_FILE: "/index/index", GIT_OBJECT_DIRECTORY: "/objects" } : { GIT_OPTIONAL_LOCKS: "0" }),
      GIT_AUTHOR_DATE: this.createdAt, GIT_COMMITTER_DATE: this.createdAt }, this.checkAuthority, input, outputLimit, exits, mounts);
    await this.check(); this.checkAuthority(); return result;
  }

  async readRef(ref: string): Promise<{ oid: string | null; symbolic: string } | null> {
    const records = (await this.run(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", ref]))
      .toString("utf8").trimEnd().split("\n").filter(Boolean).map(record => record.split("\0"));
    const matches = records.filter(record => record[0] === ref);
    if (matches.length === 0) {
      const symbolic = (await this.run(["symbolic-ref", "-q", ref], undefined, undefined, [0, 1])).toString("utf8").trimEnd();
      return symbolic ? { oid: null, symbolic } : null;
    }
    const record = matches[0]!;
    if (matches.length !== 1 || record.length !== 3 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record[1]!)) {
      throw new JarvisError("TASK_PUBLICATION_REF_INVALID");
    }
    return { oid: record[1]!, symbolic: record[2]! };
  }

  async close(): Promise<void> {
    if (this.index) for (const name of ["index.lock", "index"]) await unlink(join(this.index.anchored, name)).catch(() => {});
    for (const directory of [...(this.index ? [this.index] : []), ...this.writes, this.common, this.gitDir, this.root]) await directory.handle.close();
    // Never recursively remove a pathname that may have been replaced by another process.
    if (this.index) await rmdir(this.index.path).catch(() => {});
  }
}

/** Capture before approval; the v2 signature binds this repository identity, not just a path and shared commit. */
export async function inspectTaskPublicationIdentity(root: string): Promise<string> {
  const git = await TaskPublicationGit.open(root, () => 10000, new Date().toISOString(), true);
  try { return git.identity; } finally { await git.close(); }
}
