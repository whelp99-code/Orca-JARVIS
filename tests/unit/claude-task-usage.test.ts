import { expect, it } from "vitest";
import { readClaudeTaskUsage } from "../../src/claude-task-usage.js";

const counters = { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 7 };
it("retains four distinct counters and the CLI estimate without summing overlapping model data", () => {
  const input = { usage: { ...counters, secret: "omitted" }, total_cost_usd: .0123,
    modelUsage: { model: { inputTokens: 99999, costUSD: 99999 } }, session_id: "not-collected" };
  const result = readClaudeTaskUsage(input);
  expect(result).toEqual({ schema_version: 1, source: "claude_result", scope: "single_invocation_main_loop",
    tokens: { status: "reported", ...counters }, estimated_cost: { status: "reported", usd: .0123 } });
  input.usage.input_tokens = 200;
  expect(result.tokens).toEqual({ status: "reported", ...counters });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.tokens)).toBe(true);
  expect(Object.isFrozen(result.estimated_cost)).toBe(true);
});
it("distinguishes reported zero from missing fields", () => {
  expect(readClaudeTaskUsage({})).toMatchObject({ tokens: { status: "missing" }, estimated_cost: { status: "missing" } });
  const zero = Object.fromEntries(Object.keys(counters).map(key => [key, 0]));
  expect(readClaudeTaskUsage({ usage: zero, total_cost_usd: 0 })).toMatchObject({
    tokens: { status: "reported", ...zero }, estimated_cost: { status: "reported", usd: 0 } });
});
it.each([undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "12"])(
  "rejects an invalid or missing counter %s without losing a separate valid cost estimate", invalid => {
    for (const key of Object.keys(counters)) {
      expect(readClaudeTaskUsage({ usage: { ...counters, [key]: invalid }, total_cost_usd: .01 })).toMatchObject({
        tokens: { status: "invalid" }, estimated_cost: { status: "reported", usd: .01 } });
    }
  });
it.each([null, [], "usage", 1])("rejects invalid usage shape %s", usage => {
  expect(readClaudeTaskUsage({ usage }).tokens).toEqual({ status: "invalid" });
});
it.each([null, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "0"])("rejects invalid cost %s independently", cost => {
  expect(readClaudeTaskUsage({ usage: counters, total_cost_usd: cost })).toMatchObject({
    tokens: { status: "reported", ...counters }, estimated_cost: { status: "invalid" } });
});
