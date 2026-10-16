/** Backend verify runs two vitest shards; they are independent when each gets its own TMPDIR. */
export const BACKEND_SHARD_COUNT = 2;

export function backendShardArgv(baseArgv, shardIndex, shardCount = BACKEND_SHARD_COUNT) {
  return [...baseArgv, `--shard=${shardIndex}/${shardCount}`];
}

export function backendShardRuns(profile, forwardedArgs, baseArgv, shardCount = BACKEND_SHARD_COUNT) {
  if (profile !== "backend" || forwardedArgs.length > 0 || shardCount < 2) return [baseArgv];
  return Array.from({ length: shardCount }, (_, index) => backendShardArgv(baseArgv, index + 1, shardCount));
}

export function backendShardsRunInParallel(profile, forwardedArgs, shardCount = BACKEND_SHARD_COUNT) {
  return profile === "backend" && forwardedArgs.length === 0 && shardCount > 1;
}
