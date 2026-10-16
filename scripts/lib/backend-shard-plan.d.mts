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
