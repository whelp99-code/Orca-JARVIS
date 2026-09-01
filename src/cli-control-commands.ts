import { ApprovedCommandExecutor } from "./approved-executor.js";
import { JarvisError } from "./db.js";
import { type CliCommandContext, commandNow } from "./cli-command-context.js";
import { integer, jsonFile, typedObject } from "./cli-command-input.js";
import {
  ControlPlane,
  type CommandApprovalReceipt,
  type ControlCancelInput,
  type ControlCommandRequestInput,
} from "./control-plane.js";
import { TaskTimeline } from "./task-timeline.js";

export async function executeControlCommand(
  context: CliCommandContext,
): Promise<Record<string, unknown> | undefined> {
  const { command, subcommand, argument, values, db } = context;
  if (command === "memory" && subcommand === "lifecycle" && values.once === true) {
    const lifecycle = context.dependencies.memoryLifecycle;
    if (lifecycle === undefined) throw new JarvisError("MEMORY_LIFECYCLE_SERVICE_UNAVAILABLE");
    return { ok: true, command: "memory.lifecycle", cycle: await lifecycle.reconcilePending(256) };
  }
  if (command === "control") {
    const control = new ControlPlane(db);
    if (subcommand === "request" && argument) {
      const input = typedObject(await jsonFile<ControlCommandRequestInput>(argument));
      return { ok: true, command: "control.request", request: control.stage(input) };
    }
    if (subcommand === "decide" && argument) {
      const receipt = typedObject(await jsonFile<CommandApprovalReceipt>(argument));
      control.decide(receipt, commandNow(context));
      return { ok: true, command: "control.decide", request_id: receipt.request_id, decision: receipt.decision };
    }
    if (subcommand === "cancel" && argument) {
      const input = typedObject(await jsonFile<ControlCancelInput>(argument));
      control.cancel(input, commandNow(context));
      return { ok: true, command: "control.cancel", request_id: input.request_id };
    }
    if (subcommand === "list") return { ok: true, command: "control.list", requests: control.list() };
    if (subcommand === "execute" && argument) {
      const execution = await new ApprovedCommandExecutor(db, undefined, undefined, {},
        () => commandNow(context), undefined, undefined,
        context.dependencies.memoryLifecycle).execute(
        argument,
        values.worker ?? "cli-approved-executor",
        commandNow(context),
      );
      return { ok: true, command: "control.execute", execution };
    }
  }
  if (command !== "timeline") return undefined;
  const timeline = new TaskTimeline(db);
  if (subcommand === "list") {
    return { ok: true, command: "timeline.list", tasks: timeline.list(values.limit ? integer(values.limit) : 100) };
  }
  if (subcommand === "show" && argument) {
    const events = timeline.timeline(argument, values.limit ? integer(values.limit) : 200);
    return { ok: true, command: "timeline.show", task_id: argument, events };
  }
  if (subcommand === "context" && argument) {
    const result = timeline.context(
      argument,
      values.limit ? integer(values.limit) : 100,
      values.max_bytes ? integer(values.max_bytes) : 128 * 1024,
      commandNow(context),
    );
    return { ok: true, command: "timeline.context", task_id: argument, context: result };
  }
  return undefined;
}
