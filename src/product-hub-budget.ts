import { PHONE_GATEWAY_LIMITS } from "./phone-gateway-protocol.js";

// The phone gateway closes the whole product-hub request at totalTimeoutMs.
// Probe work must finish before that, leaving time to write a partial response.
export const PRODUCT_HUB_RESPONSE_RESERVE_MS = 2_000;
export const PRODUCT_HUB_PROBE_BUDGET_MS = PHONE_GATEWAY_LIMITS.totalTimeoutMs - PRODUCT_HUB_RESPONSE_RESERVE_MS;

if (PRODUCT_HUB_PROBE_BUDGET_MS >= PHONE_GATEWAY_LIMITS.totalTimeoutMs || PRODUCT_HUB_PROBE_BUDGET_MS < 1_000) {
  throw new Error("product hub probe budget is not inside the gateway budget");
}
