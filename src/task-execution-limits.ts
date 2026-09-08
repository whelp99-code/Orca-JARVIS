/** Compiled resource contract, not request-configurable permissions. Units are milliseconds and bytes. */
export const TASK_PLAN_LIMITS = Object.freeze({
  min_timeout_ms: 1000, max_timeout_ms: 600_000,
  min_output_bytes: 1024, max_output_bytes: 1_048_576,
  max_files: 128, max_verification_checks: 8,
});
/** Remaining execution budgets may be smaller than the original plan minimum. */
export const TASK_PROVIDER_LIMITS = Object.freeze({
  min_timeout_ms: 1, max_timeout_ms: TASK_PLAN_LIMITS.max_timeout_ms,
  min_output_bytes: 1, max_output_bytes: TASK_PLAN_LIMITS.max_output_bytes,
  max_prompt_bytes: 512 * 1024,
});
export const TASK_FILE_LIMITS = Object.freeze({ max_file_bytes: 4 * 1024 * 1024, max_total_bytes: 16 * 1024 * 1024 });
export const TASK_EXECUTION_LIMITS = Object.freeze({ plan: TASK_PLAN_LIMITS, provider: TASK_PROVIDER_LIMITS, files: TASK_FILE_LIMITS });
