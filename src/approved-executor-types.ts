export interface ApprovedExecutionResult {
  request_id: string;
  action: string;
  state: "completed" | "failed" | "uncertain";
  result: unknown;
  failure_code?: string;
}
