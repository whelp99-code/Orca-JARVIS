import type { ApprovedExecutionResult } from "./approved-executor-types.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service-types.js";
export { executeAbandonedNotDelivered } from "./memory-outbox-abandon.js";

export async function executeApprovedMemoryCommand(
  service: Pick<MemoryLifecycleService, "execute">,
  command: ClaimedControlCommand,
): Promise<ApprovedExecutionResult> {
  const executed = await service.execute(command);
  switch (executed.kind) {
    case "correction": {
      const completed = executed.state === "settled";
      return { request_id: command.request_id, action: command.action,
        state: completed ? "completed" : "uncertain",
        result: { correction_id: executed.id, state: executed.state,
          request_digest: executed.request_digest },
        ...(completed ? {} : { failure_code: "MEMORY_CORRECTION_RECONCILING" }) };
    }
    case "deletion": {
      const completed = executed.state === "settled";
      const refused = executed.state === "conflict";
      return { request_id: command.request_id, action: command.action,
        state: completed ? "completed" : refused ? "failed" : "uncertain",
        result: { deletion_id: executed.id, state: executed.state },
        ...(completed ? {} : { failure_code: refused ? "MEMORY_DELETION_REFUSED" : "MEMORY_DELETION_RECONCILING" }) };
    }
    case "export": {
      const completed = executed.state === "available";
      return { request_id: command.request_id, action: command.action,
        state: completed ? "completed" : "uncertain",
        result: { export_id: executed.id, state: executed.state },
        ...(completed ? {} : { failure_code: "MEMORY_EXPORT_WRITING" }) };
    }
    default:
      return assertNever(executed);
  }
}

function assertNever(value: never): never {
  return value;
}
