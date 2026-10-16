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
