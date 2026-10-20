/** Backend verify runs two vitest shards in parallel (unit vs integration+longitudinal). */
export const BACKEND_SHARD_COUNT = 2;

/** @param {readonly string[]} baseArgv */
export function backendShardRuns(profile, forwardedArgs, baseArgv, shardCount = BACKEND_SHARD_COUNT) {
  if (profile !== "backend" || forwardedArgs.length > 0 || shardCount < 2) return [baseArgv];
  return [
    [...baseArgv, "tests/unit"],
    [...baseArgv, "tests/integration", "tests/longitudinal"],
  ];
}

export function backendShardsRunInParallel(profile, forwardedArgs, shardCount = BACKEND_SHARD_COUNT) {
  return profile === "backend" && forwardedArgs.length === 0 && shardCount > 1;
}

const SIGNAL_EXIT = {
  SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGILL: 132, SIGTRAP: 133, SIGABRT: 134, SIGBUS: 135, SIGFPE: 136,
  SIGKILL: 137, SIGUSR1: 138, SIGSEGV: 139, SIGUSR2: 140, SIGPIPE: 141, SIGALRM: 142, SIGTERM: 143,
};

/** Vitest 3.2 stores results under Vite cacheDir, not an unread VITEST_CACHE_DIR. */
export function vitestCacheDir(env = process.env) {
  const dir = env.VITEST_CACHE_DIR;
  if (typeof dir !== "string" || dir.trim() === "") return undefined;
  return dir.trim();
}

/** A signal death is a failure. Runner-owned interruption stays 130. */
export function classifyTestResult(result) {
  if (result.interrupted) return { interrupted: true, code: 130, signal: result.signal ?? null };
  if (typeof result.code === "number") return { interrupted: false, code: result.code, signal: result.signal ?? null };
  const code = result.signal ? SIGNAL_EXIT[result.signal] : undefined;
  return { interrupted: false, code: code ?? 1, signal: result.signal ?? null };
}

/** Parent cancellation wins. A sibling abort must not hide the real nonzero code. */
export function combineShardExit(outcomes, parentAborted) {
  if (parentAborted) return 130;
  const failure = outcomes.find((outcome) => outcome.code !== 0 && outcome.code !== 130);
  if (failure) return failure.code;
  if (outcomes.some((outcome) => outcome.interrupted || outcome.code === 130)) return 130;
  return 0;
}

export function headlessGuiPlan({ profile, platform, display, argv, execPath, privateTmp }) {
  const headless = profile === "gui" && platform === "linux" && !String(display ?? "").trim();
  if (!headless) return { command: execPath, argv: [...argv] };
  return {
    command: "bwrap",
    argv: [
      "--die-with-parent", "--unshare-pid", "--bind", "/", "/", "--dev-bind", "/dev", "/dev",
      "--bind", privateTmp, "/tmp", "--proc", "/proc", "--", execPath, ...argv,
    ],
  };
}

export async function settleParallelShards({ runs, runShard, createEnvironment, parentSignal, onError = () => {} }) {
  const cleanups = [];
  const shardAbort = new AbortController();
  const shardSignal = AbortSignal.any([parentSignal, shardAbort.signal]);
  try {
    const outcomes = await Promise.all(runs.map(async (argv, index) => {
      let scratch;
      try {
        scratch = createEnvironment();
        cleanups.push(scratch.cleanup);
        const outcome = await runShard(argv, scratch, shardSignal, index);
        if (outcome.interrupted || outcome.signal != null) shardAbort.abort();
        return outcome;
      } catch (error) {
        shardAbort.abort();
        onError(error);
        return { interrupted: false, code: 2, signal: null };
      }
    }));
    return { outcomes, exitCode: combineShardExit(outcomes, parentSignal.aborted) };
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
}
