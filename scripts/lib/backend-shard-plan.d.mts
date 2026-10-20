export const BACKEND_SHARD_COUNT: 2;

export function backendShardRuns(
  profile: string,
  forwardedArgs: string[],
  baseArgv: string[],
  shardCount?: number,
): string[][];

export function backendShardsRunInParallel(
  profile: string,
  forwardedArgs: string[],
  shardCount?: number,
): boolean;

export function vitestCacheDir(env?: NodeJS.ProcessEnv): string | undefined;

export function classifyTestResult(result: {
  code: number | null;
  signal?: NodeJS.Signals | null;
  interrupted?: boolean;
}): { interrupted: boolean; code: number; signal: NodeJS.Signals | null };

export function combineShardExit(
  outcomes: readonly { interrupted?: boolean; code: number }[],
  parentAborted: boolean,
): number;

export function headlessGuiPlan(input: {
  profile: string;
  platform: string;
  display?: string;
  argv: readonly string[];
  execPath: string;
  privateTmp: string;
}): { command: string; argv: string[] };

export function settleParallelShards(input: {
  runs: readonly string[][];
  runShard: (
    argv: string[],
    scratch: { env: NodeJS.ProcessEnv; root: string; cleanup: () => void },
    signal: AbortSignal,
    index: number,
  ) => Promise<{ interrupted: boolean; code: number; signal: NodeJS.Signals | null }>;
  createEnvironment: () => { env: NodeJS.ProcessEnv; root: string; cleanup: () => void };
  parentSignal: AbortSignal;
  onError?: (error: unknown) => void;
}): Promise<{ outcomes: { interrupted: boolean; code: number; signal: NodeJS.Signals | null }[]; exitCode: number }>;
