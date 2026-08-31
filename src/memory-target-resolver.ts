import type {
  ResolveMemoryTargetInput,
  SecondBrainEffectService,
  SecondBrainEffectServiceResult,
} from "./second-brain-effect-service.js";
import type { ResolvedMemoryTargetV2 } from "./second-brain-effect-v2.js";

export class MemoryTargetResolver {
  constructor(private readonly provider: SecondBrainEffectService) {}

  resolve(
    input: ResolveMemoryTargetInput,
  ): Promise<SecondBrainEffectServiceResult<ResolvedMemoryTargetV2>> {
    return this.provider.resolveTarget(input);
  }
}
