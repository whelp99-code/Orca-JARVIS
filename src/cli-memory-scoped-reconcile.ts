import { JarvisError } from "./db.js";
import { commandNow, type CliCommandContext } from "./cli-command-context.js";
import { createProductionScopedReconciler } from "./memory-scoped-reconcile-production.js";

export async function executeMemoryScopedReconcile(context: CliCommandContext): Promise<Record<string, unknown>> {
  if (context.values.once !== true || !context.argument || context.fourth !== undefined
    || context.values.session_id !== undefined || context.values.input !== undefined || context.values["key-file"] !== undefined
    || (context.values.worker !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(context.values.worker)))
    throw new JarvisError("MEMORY_SCOPED_RECONCILE_INPUT_INVALID");
  const configured = context.dependencies.scopedMemoryReconcileOptions;
  if (configured === undefined) throw new JarvisError("MEMORY_SCOPED_RECONCILE_CONFIG_REQUIRED");
  const runtime = createProductionScopedReconciler(context.db, { ...configured, clock: () => commandNow(context) });
  try {
    const result = await runtime.runOnce(context.argument, context.values.worker ?? "cli:scoped-reconcile");
    return { ok: true, command: "memory.reconcile-scoped", result };
  } finally { await runtime.close(); }
}
