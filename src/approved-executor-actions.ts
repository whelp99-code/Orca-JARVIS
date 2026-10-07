/** Actions ApprovedCommandExecutor claims. memory.confirm is handled even though executable is false. */
const EXECUTOR_ACTIONS = new Set([
  "task.execute",
  "database.backup",
  "database.restore_drill",
  "state.project",
  "workflow.register",
  "workflow.start",
  "workflow.advance",
  "workflow.cancel",
  "runbook.execute",
  "evidence.negative.record",
  "memory.confirm",
  "memory.outbox.dispatch",
  "memory.outbox.abandon-not-delivered",
  "memory.delete",
  "memory.export",
  "memory.generation.rollback",
]);

export function approvedActionHasExecutor(action: string): boolean {
  return EXECUTOR_ACTIONS.has(action);
}
