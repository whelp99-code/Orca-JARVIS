type Unavailable = { readonly status: "missing" | "invalid" };
type Tokens = {
  readonly status: "reported";
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
};
export interface ClaudeTaskUsage {
  readonly schema_version: 1;
  readonly source: "claude_result";
  readonly scope: "single_invocation_main_loop";
  readonly tokens: Tokens | Unavailable;
  readonly estimated_cost: { readonly status: "reported"; readonly usd: number } | Unavailable;
}

/** Result-level CLI telemetry only. Neither billing proof nor execution authority.
 * The task adapter disables tools/subagents and starts a fresh, non-streaming call.
 * Do not sum modelUsage or message usage into this result-level observation. */
export function readClaudeTaskUsage(result: Record<string, unknown>): ClaudeTaskUsage {
  const usage = result.usage;
  const keys = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
  let tokens: Tokens | Unavailable;
  if (usage === undefined) tokens = { status: "missing" };
  else if (usage === null || typeof usage !== "object" || Array.isArray(usage)) tokens = { status: "invalid" };
  else {
    const values = usage as Record<string, unknown>;
    if (keys.some(key => typeof values[key] !== "number" || !Number.isSafeInteger(values[key]) || values[key] < 0)) {
      tokens = { status: "invalid" };
    } else tokens = { status: "reported", input_tokens: values.input_tokens as number,
      output_tokens: values.output_tokens as number, cache_read_input_tokens: values.cache_read_input_tokens as number,
      cache_creation_input_tokens: values.cache_creation_input_tokens as number };
  }
  const cost = result.total_cost_usd;
  const estimatedCost: ClaudeTaskUsage["estimated_cost"] = cost === undefined ? { status: "missing" }
    : typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && cost <= Number.MAX_SAFE_INTEGER
      ? { status: "reported", usd: cost } : { status: "invalid" };
  return Object.freeze({ schema_version: 1, source: "claude_result", scope: "single_invocation_main_loop",
    tokens: Object.freeze(tokens), estimated_cost: Object.freeze(estimatedCost) });
}
