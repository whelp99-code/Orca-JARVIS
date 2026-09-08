import { expect, it } from "vitest";
import { JarvisError } from "../../src/db.js";
import { phoneMemoryContextError } from "../../src/phone-memory-context-error.js";
import { ERROR_STATUS } from "../../src/phone-gateway-protocol.js";

it.each([
  ["MEMORY_ACCESS_SCOPE_UNAVAILABLE", 403], ["MEMORY_REFERENCE_SCOPE_CHANGED", 403],
  ["MEMORY_CONTEXT_BUSY", 429], ["MEMORY_REFERENCE_INPUT_INVALID", 400],
  ["MEMORY_REFERENCE_BUDGET_IMPOSSIBLE", 400], ["MEMORY_REFERENCE_GENERATION_CHANGED", 409],
  ["MEMORY_REFERENCE_PRIVACY_CHANGED", 409], ["MEMORY_REFERENCE_SUPPRESSED", 409],
  ["MEMORY_REFERENCE_EXPIRED", 409], ["MEMORY_REFERENCE_PROVIDER_UNAVAILABLE", 503],
  ["MEMORY_REFERENCE_PRIVACY_UNAVAILABLE", 503], ["MEMORY_SCOPED_CONFIG_INVALID", 503],
  ["MEMORY_REFERENCE_CONFIG_AMBIGUOUS", 503], ["MEMORY_REFERENCE_KEY_UNAVAILABLE", 503],
  ["MEMORY_READ_FENCE_KEY_UNAVAILABLE", 503],
] as const)("maps %s to a bounded HTTP category", (code, status) => {
  const mapped = phoneMemoryContextError(new JarvisError(code));
  expect(mapped).toBeDefined(); expect(ERROR_STATUS[mapped!]).toBe(status);
});
it("does not trust arbitrary objects or forward unknown provider error details", () => {
  expect(phoneMemoryContextError({ code: "MEMORY_ACCESS_SCOPE_UNAVAILABLE" })).toBeUndefined();
  expect(phoneMemoryContextError(new Error("private path /fixture/secret"))).toBeUndefined();
  expect(phoneMemoryContextError(new JarvisError("PRIVATE_PROVIDER_DETAIL"))).toBeUndefined();
});
