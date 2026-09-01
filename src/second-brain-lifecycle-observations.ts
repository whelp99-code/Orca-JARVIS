import { JarvisError } from "./db.js";
import {
  parseMemoryLifecycleObservationManifest,
  type MemoryLifecycleObservationBinding,
  type MemoryLifecycleObservationSource,
  type ParsedMemoryLifecycleObservationManifest,
} from "./memory-lifecycle-observation-manifest.js";
import type { SecondBrainEffectService } from "./second-brain-effect-service.js";

export class SecondBrainStatusObservationSource implements MemoryLifecycleObservationSource {
  constructor(private readonly provider: SecondBrainEffectService) {}

  async observe(
    binding: MemoryLifecycleObservationBinding,
  ): Promise<ParsedMemoryLifecycleObservationManifest> {
    const status = await this.provider.requestStatus(binding.request_id);
    switch (status.kind) {
      case "data":
        if (status.value.state !== "proved" || !Object.hasOwn(status.value, "observations")) {
          throw new JarvisError("MEMORY_LIFECYCLE_OBSERVATION_UNAVAILABLE");
        }
        return parseMemoryLifecycleObservationManifest(status.value.observations, binding);
      case "invalid": case "unavailable": case "uncertain":
        throw new JarvisError("MEMORY_LIFECYCLE_OBSERVATION_UNAVAILABLE");
      default:
        return assertNever(status);
    }
  }
}

function assertNever(value: never): never {
  throw new JarvisError(`MEMORY_LIFECYCLE_OBSERVATION_UNAVAILABLE:${String(value)}`);
}
