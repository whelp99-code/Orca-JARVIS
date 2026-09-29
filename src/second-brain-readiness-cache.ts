import type { SecondBrainReadinessObservation, SecondBrainReadinessProbe } from "./second-brain-readiness.js";
import { runtimeSecondBrainReadinessProbe } from "./second-brain-readiness-runtime.js";

export const SECOND_BRAIN_READINESS_CACHE_TTL_MS = 30_000;

export function cachedSecondBrainReadinessProbe(
  inner: SecondBrainReadinessProbe,
  ttlMs = SECOND_BRAIN_READINESS_CACHE_TTL_MS,
  now: () => Date = () => new Date(),
): SecondBrainReadinessProbe {
  let cached: { at: number; value: SecondBrainReadinessObservation } | undefined;
  let inflight: Promise<SecondBrainReadinessObservation> | undefined;
  const refresh = (): Promise<SecondBrainReadinessObservation> => {
    inflight ??= inner.inspect().then((value) => {
      cached = { at: now().getTime(), value };
      return value;
    }).finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
  return {
    inspect: async () => {
      const age = cached === undefined ? Number.POSITIVE_INFINITY : now().getTime() - cached.at;
      if (cached !== undefined && age < ttlMs) return cached.value;
      if (cached !== undefined) {
        void refresh();
        return cached.value;
      }
      return await refresh();
    },
  };
}

let sharedHealthProbe: SecondBrainReadinessProbe | undefined;
export function cachedRuntimeSecondBrainReadinessProbe(): SecondBrainReadinessProbe {
  sharedHealthProbe ??= cachedSecondBrainReadinessProbe(runtimeSecondBrainReadinessProbe());
  return sharedHealthProbe;
}
