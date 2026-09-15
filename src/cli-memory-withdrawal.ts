import { commandNow, type CliCommandContext } from "./cli-command-context.js";
import { JarvisError } from "./db.js";
import { memoriesAwaitingTaskWithdrawal } from "./memory-candidate-task-source.js";
import { createProductionMemoryWithdrawal } from "./memory-withdrawal-production.js";

/**
 * What a hidden task still has stored with the provider.
 *
 * A read of this database only: it needs no provider and no owner decision, so the owner can see
 * what is outstanding before deciding whether to ask for anything back. An empty list is the
 * evidence that nothing is outstanding.
 */
export function executeMemoryWithdrawalList(
  context: CliCommandContext,
): Record<string, unknown> {
  if (context.argument !== undefined || context.fourth !== undefined) {
    throw new JarvisError("MEMORY_WITHDRAWAL_INPUT_INVALID");
  }
  const items = memoriesAwaitingTaskWithdrawal(context.db);
  return { ok: true, command: "memory.withdrawals", items,
    stored: items.filter(item => item.target_id !== null).length };
}

/**
 * Prepares the owner-approval command that withdraws one stored derived memory.
 *
 * Preparation only. The command this returns has to be approved by the owner through the control
 * plane before the existing deletion saga will send anything, and a copy the provider will not
 * confirm right now is reported as refused rather than prepared.
 */
export async function executeMemoryWithdrawalPrepare(
  context: CliCommandContext,
): Promise<Record<string, unknown>> {
  const candidateId = context.argument;
  if (candidateId === undefined || context.fourth !== undefined
    || !/^memcand:[A-Za-z0-9:_-]{1,128}$/.test(candidateId)) {
    throw new JarvisError("MEMORY_WITHDRAWAL_INPUT_INVALID");
  }
  const configured = context.dependencies.memoryWithdrawalOptions;
  const lifecycle = context.dependencies.memoryLifecycle;
  if (configured === undefined) throw new JarvisError("MEMORY_WITHDRAWAL_CONFIG_REQUIRED");
  if (lifecycle === undefined) throw new JarvisError("MEMORY_LIFECYCLE_SERVICE_UNAVAILABLE");
  const runtime = createProductionMemoryWithdrawal(context.db,
    { ...configured, clock: () => commandNow(context) });
  try {
    const entry = runtime.withdrawal.pending().find(item => item.candidate_id === candidateId);
    if (entry === undefined) throw new JarvisError("MEMORY_WITHDRAWAL_NOT_OUTSTANDING");
    const outcome = await runtime.withdrawal.resolve(entry);
    if (outcome.kind !== "resolved") {
      return { ok: false, command: "memory.withdraw-prepare", refused: outcome.value };
    }
    const request = await runtime.withdrawal.prepare(outcome.value,
      input => lifecycle.prepareDeletion(input));
    return { ok: true, command: "memory.withdraw-prepare", candidate_id: candidateId,
      task_id: outcome.value.task_id, target_id: outcome.value.target.target_id, request };
  } finally { await runtime.close(); }
}
