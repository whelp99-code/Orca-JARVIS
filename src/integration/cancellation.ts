import { JarvisError } from "../jarvis-error.js";
import type { ExecutionResult, ExecutionStatus } from "./types.js";

export type ExternalEffectWindow = "none" | "possible" | "observed";

export type CancelDecision = {
  readonly status: Extract<ExecutionStatus, "CANCELLED" | "CANCELLED_AFTER_POSSIBLE_EFFECT">;
  readonly effect_window: ExternalEffectWindow;
};

export function decideCancellation(window: ExternalEffectWindow): CancelDecision {
  if (window === "none") {
    return { status: "CANCELLED", effect_window: window };
  }
  return { status: "CANCELLED_AFTER_POSSIBLE_EFFECT", effect_window: window };
}

export function applyCancellation(result: Pick<ExecutionResult, "status">, window: ExternalEffectWindow): CancelDecision {
  if (result.status === "SUCCESS" || result.status === "FAIL") {
    throw new JarvisError("CORE5_CANCEL_AFTER_TERMINAL", result.status);
  }
  return decideCancellation(window);
}
