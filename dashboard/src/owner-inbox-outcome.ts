export type InboxExecution = Readonly<{
  state?: string;
  failure_code?: string;
  manual_wait?: boolean;
  primary?: InboxExecution;
  carried?: InboxExecution;
}>;

export type InboxOutcome = Readonly<{
  state: "completed" | "failed" | "uncertain" | "approved" | "rejected";
  failure_code?: string;
}>;

export function inboxExecutionOutcome(decision: "approve" | "reject", execution: InboxExecution | undefined): InboxOutcome {
  if (decision === "reject") return { state: "rejected" };
  if (execution === undefined) return { state: "uncertain", failure_code: "APPROVED_COMMAND_FAILED" };
  const leaf = execution.primary ?? execution;
  if (leaf?.manual_wait === true || leaf?.state === "approved") return { state: "approved" };
  if (leaf?.state === "failed") return { state: "failed", ...(leaf.failure_code ? { failure_code: leaf.failure_code } : {}) };
  if (leaf?.state === "uncertain") return { state: "uncertain", ...(leaf.failure_code ? { failure_code: leaf.failure_code } : {}) };
  if (leaf?.state === "completed") return { state: "completed" };
  return { state: "completed" };
}

export function inboxOutcomeText(outcome: InboxOutcome, action?: string): string {
  if (outcome.state === "rejected") return "거절했습니다.";
  if (outcome.state === "failed") return `승인됨 — 실행 실패 (코드: ${outcome.failure_code ?? "APPROVED_COMMAND_FAILED"})`;
  if (outcome.state === "uncertain") return `승인됨 — 결과 확인 중 (코드: ${outcome.failure_code ?? "APPROVED_COMMAND_FAILED"})`;
  if (outcome.state === "approved" && action === "external.delegate") return "승인됨 — 외부 실행";
  if (outcome.state === "approved") return "승인됨 — 실행 대기(수동)";
  return "승인·실행 완료";
}
