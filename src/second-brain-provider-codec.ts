import type { SecondBrainProviderMethod } from "./second-brain-provider-contract.js";
import type { ProviderJson as Json } from "./second-brain-provider-contract.js";

export const PROVIDER_FRAME_BYTES = 1_048_576;
export const PROVIDER_MUTATING_METHODS = new Set<SecondBrainProviderMethod>([
  "sb_write_request",
  "sb_reconcile_write",
  "sb_restore_request",
  "sb_observe_artifact",
  "sb_remember",
  "sb_run",
]);

export type ProviderPending = {
  readonly resolve: (value: Json) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly write: boolean;
};

export function isProviderRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asProviderRecord(
  value: unknown,
  code = "SECOND_BRAIN_PROVIDER_VALUE_INVALID",
): Json {
  if (!isProviderRecord(value)) throw new Error(code);
  return value;
}

export function assertProviderBounded(value: unknown): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > PROVIDER_FRAME_BYTES) {
    throw new Error("SECOND_BRAIN_PROVIDER_ARGUMENTS_OVERSIZE");
  }
}

export function providerDeadline(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 1 && value <= 60_000
    ? value
    : fallback;
}

export function providerLauncherArgs(
  launcher: string,
  configured?: readonly string[],
): readonly string[] {
  if (configured !== undefined) return [...configured];
  const fromEnvironment = process.env.SECOND_BRAIN_PROVIDER_ARGS?.trim();
  if (fromEnvironment) return fromEnvironment.split(/\s+/u);
  return launcher.endsWith("/sb") ? ["mcp"] : [];
}

export function providerToolPayload(result: Json): Json {
  const entry = Array.isArray(result.content) ? result.content[0] : undefined;
  if (isProviderRecord(entry) && typeof entry.text === "string") {
    return asProviderRecord(JSON.parse(entry.text));
  }
  return asProviderRecord(result.structuredContent);
}

export function providerToolError(result: Json): string {
  try {
    const payload = providerToolPayload(result);
    return typeof payload.code === "string"
      ? payload.code
      : "SECOND_BRAIN_PROVIDER_TOOL_ERROR";
  } catch {
    return "SECOND_BRAIN_PROVIDER_TOOL_ERROR";
  }
}
