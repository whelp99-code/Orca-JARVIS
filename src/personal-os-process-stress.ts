import { spawn, type ChildProcess } from "node:child_process";
import { openUnderSwapAdmission } from "./authority-database-swap-barrier.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AuthorityDb } from "./db.js";
import {
  PERSONAL_OS_CONTROL_CHANNEL_ENV,
  connectCycleClient,
  readCycleCursor,
  withWatchdog,
  type PersonalOsCycleClient,
} from "./personal-os-cycle-channel.js";
import { PersonalOsError } from "./personal-os-errors.js";
import { assertIsolatedRoot } from "./personal-os-protected-paths.js";
import { isolatedRenderRoots, renderSystemdUnit } from "./personal-os-systemd.js";
import { waitForCycleReady } from "./personal-os-cycle-ready.js";

export type ProcessStressInput = {
  readonly isolatedRoot: string;
  readonly worktree: string;
  readonly cycleCount: number;
  readonly crashAfterDispatchId: number;
};

export type ProcessStressReceipt = {
  readonly cycles_requested: number;
  readonly cycles_completed: number;
  readonly logical_duplicates: number;
  readonly restart_count: number;
  readonly runtime_crash_count: number;
  readonly active_handles_at_exit: number;
  readonly owned_listeners_at_exit: number;
  readonly owned_processes_at_exit: number;
  readonly runtime_surface: "staged-execstart";
  readonly child_pids: readonly number[];
  readonly socket_path: string;
  readonly db_path: string;
};

function parseExecStart(unitText: string): readonly [string, ...string[]] {
  const line = unitText.split("\n").find((row) => row.startsWith("ExecStart="));
  if (line === undefined) throw new PersonalOsError("E_PROCESS_STRESS");
  const parts = line.slice("ExecStart=".length).trim().split(/\s+/);
  const binary = parts[0];
  if (binary === undefined || binary.length === 0) throw new PersonalOsError("E_PROCESS_STRESS");
  return [binary, ...parts.slice(1)];
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function killTree(pid: number): void {
  if (pid === process.pid) throw new PersonalOsError("E_PROCESS_STRESS");
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
      try {
        process.kill(pid, "SIGKILL");
      } catch (inner) {
        if (!(inner instanceof Error) || !("code" in inner) || inner.code !== "ESRCH") throw inner;
      }
    }
  }
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return withWatchdog(
    new Promise((resolve) => {
      child.once("exit", () => resolve());
    }),
    timeoutMs,
  );
}

function startChild(input: {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly dbPath: string;
  readonly socketPath: string;
}): ChildProcess {
  unlinkIfExists(input.socketPath);
  const [binary, ...args] = input.argv;
  const child = spawn(binary, args, {
    cwd: input.cwd,
    env: {
      ...process.env,
      [PERSONAL_OS_CONTROL_CHANNEL_ENV]: input.socketPath,
      JARVIS_DB: input.dbPath,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.resume(); child.stderr?.resume();
  return child;
}

export async function runPersonalOsProcessStress(input: ProcessStressInput): Promise<ProcessStressReceipt> {
  const isolatedRoot = assertIsolatedRoot(input.isolatedRoot);
  if (input.cycleCount < 1 || input.crashAfterDispatchId < 1 || input.crashAfterDispatchId > input.cycleCount) {
    throw new PersonalOsError("E_PROCESS_STRESS");
  }
  const dbPath = join(isolatedRoot, "jarvis.sqlite");
  const socketPath = join(isolatedRoot, "c.sock");
  const unit = renderSystemdUnit({
    id: "jm-jarvis.service",
    mode: "fixture",
    roots: isolatedRenderRoots({
      root: isolatedRoot,
      authorityCurrent: input.worktree,
      jarvisDb: dbPath,
    }),
  });
  const argv = parseExecStart(unit);
  const authority = new AuthorityDb(dbPath);
  await authority.migrate();
  authority.close();
  const childPids: number[] = [];
  let child = startChild({ argv, cwd: input.worktree, dbPath, socketPath });
  let client: PersonalOsCycleClient | undefined;
  try {
    await waitForCycleReady(child, socketPath, 30_000);
    if (child.pid === undefined) throw new PersonalOsError("E_PROCESS_STRESS");
    childPids.push(child.pid);
    client = await connectCycleClient(socketPath);
    const requested = new Set<number>();
    const completed = new Set<number>();
    let restart_count = 0;
    let runtime_crash_count = 0;
    for (let id = 1; id <= input.cycleCount; id += 1) {
      if (id === input.crashAfterDispatchId) {
        const pid = child.pid;
        if (pid === undefined) throw new PersonalOsError("E_PROCESS_STRESS");
        const inflight = client.subscribe(id);
        client.sendRequested(id);
        requested.add(id);
        killTree(pid);
        runtime_crash_count += 1;
        await waitExit(child, 5_000);
        client.close();
        await inflight;
        child = startChild({ argv, cwd: input.worktree, dbPath, socketPath });
        restart_count += 1;
        await waitForCycleReady(child, socketPath, 30_000);
        if (child.pid === undefined) throw new PersonalOsError("E_PROCESS_STRESS");
        childPids.push(child.pid);
        client = await connectCycleClient(socketPath);
        await client.request(id, 5_000);
        completed.add(id);
        continue;
      }
      await client.request(id, 5_000);
      requested.add(id);
      completed.add(id);
    }
    client.sendShutdown();
    await waitExit(child, 5_000);
    client.close();
    const sqlite = openUnderSwapAdmission(dbPath,
      () => new Database(dbPath, { readonly: true, fileMustExist: true }));
    const cursor = readCycleCursor(sqlite);
    sqlite.close();
    unlinkIfExists(socketPath);
    const owned_processes_at_exit = childPids.filter((pid) => processAlive(pid)).length;
    return {
      cycles_requested: requested.size,
      cycles_completed: completed.size,
      logical_duplicates: Math.max(0, cursor.applied_count - input.cycleCount),
      restart_count,
      runtime_crash_count,
      active_handles_at_exit: owned_processes_at_exit,
      owned_listeners_at_exit: existsSync(socketPath) ? 1 : 0,
      owned_processes_at_exit,
      runtime_surface: "staged-execstart",
      child_pids: childPids,
      socket_path: socketPath,
      db_path: dbPath,
    };
  } finally {
    if (child.pid !== undefined && processAlive(child.pid)) killTree(child.pid);
    client?.close();
    unlinkIfExists(socketPath);
  }
}
