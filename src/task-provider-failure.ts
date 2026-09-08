import { JarvisError } from "./jarvis-error.js";
import type { ClaudeTaskUsage } from "./claude-task-usage.js";

/** A failed invocation with bounded, normalized telemetry. Never candidate data or authority. */
export class TaskProviderFailure extends JarvisError {
  constructor(code: "TASK_PROVIDER_FAILED" | "TASK_PROVIDER_RESULT_INVALID", readonly usage: ClaudeTaskUsage) {
    super(code);
  }
}
