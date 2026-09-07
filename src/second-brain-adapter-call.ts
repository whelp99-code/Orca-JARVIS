import { JarvisError } from "./db.js";
import { bindSecondBrainGenerationRead } from "./second-brain-generation-read.js";
import { normalizeSecondBrainProviderRecord } from "./second-brain-provider-value.js";
import type { SecondBrainAdapterOptions, SecondBrainReadOutcome } from "./second-brain-adapter-types.js";
import { SecondBrainTransportError, type SecondBrainOutcome, type SecondBrainReadMethod } from "./second-brain-transport.js";

const OFFLINE_CODES = ["SECOND_BRAIN_CHILD_EXIT", "SECOND_BRAIN_DISCOVERY_FAILED", "SECOND_BRAIN_START_FAILED"] as const;
type CallResult =
  | { readonly kind: "transport"; readonly outcome: SecondBrainOutcome }
  | { readonly kind: "adapter"; readonly outcome: SecondBrainReadOutcome };
function invalid(code: string, checkedAt: Date): SecondBrainReadOutcome {
  return { kind: "invalid", code, checked_at: checkedAt.toISOString() };
}

/** State belongs to one public read, including that read's dependent page calls. */
export async function callSecondBrainRead(
  options: SecondBrainAdapterOptions,
  contractProfile: "schema3-read-only" | "schema4",
  unboundGenerations: Map<SecondBrainReadMethod, string>,
  method: SecondBrainReadMethod,
  arguments_: Readonly<Record<string, unknown>>,
  checkedAt: Date,
): Promise<CallResult> {
  try {
    const readFence = options.read_fence?.(checkedAt);
    const outcome = await options.transport.call(method,
      readFence === undefined ? arguments_ : { ...arguments_, read_fence: readFence });
    if (outcome.kind !== "data") return { kind: "transport", outcome };
    const value = normalizeSecondBrainProviderRecord(outcome.value);
    const bound = value === undefined
      ? undefined
      : bindSecondBrainGenerationRead(value, { fence: readFence, method,
        contract_profile: contractProfile, unbound_generations: unboundGenerations });
    return bound === undefined
      ? { kind: "adapter", outcome: invalid("SECOND_BRAIN_PROVIDER_VALUE_INVALID", checkedAt) }
      : { kind: "transport", outcome: { kind: "data", value: bound } };
  } catch (error) {
    if (error instanceof JarvisError && ["MEMORY_READ_FENCE_KEY_UNAVAILABLE", "MEMORY_READ_FENCE_AUTHORITY_UNAVAILABLE"].includes(error.code)) {
      return { kind: "adapter", outcome: invalid(error.code, checkedAt) };
    }
    if (!(error instanceof SecondBrainTransportError)) throw error;
    const kind = OFFLINE_CODES.some(code => code === error.code) ? "offline" : error.disposition === "fatal" ? "invalid" : "unavailable";
    return { kind: "adapter", outcome: { kind, code: error.code, checked_at: checkedAt.toISOString() } };
  }
}
