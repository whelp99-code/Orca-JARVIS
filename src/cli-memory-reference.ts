import { JarvisError } from "./db.js";
import { commandNow, type CliCommandContext } from "./cli-command-context.js";
import { MemoryReferenceError } from "./memory-reference-context.js";
import { createProductionMemoryReference } from "./memory-reference-production.js";
import { createProductionScopedMemory } from "./memory-scoped-production.js";

function limit(raw: string | undefined, fallback: number, maximum: number): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]{0,4}$/.test(raw) || Number(raw) > maximum) throw new JarvisError("MEMORY_REFERENCE_INPUT_INVALID");
  return Number(raw);
}

export async function executeMemoryReference(context: CliCommandContext): Promise<Record<string, unknown>> {
  if (context.argument === undefined || context.fourth !== undefined) throw new JarvisError("MEMORY_REFERENCE_INPUT_INVALID");
  const count = limit(context.values.limit, 8, 32);
  const maximum = limit(context.values.max_bytes, 16384, 65536);
  const envelope = { version: 1, ok: true, command: "memory.context", context: null,
    context_digest: `sha256:${"0".repeat(64)}`, context_bytes: 65536,
    provider_status_received_at: "2000-01-01T00:00:00.000Z" };
  // Reserve the exact outer shape with the longest possible byte-count field,
  // including the CLI version and final newline. The context itself is not copied.
  const overhead = Buffer.byteLength(`${JSON.stringify(envelope)}\n`) - 4;
  if (maximum <= overhead) throw new JarvisError("MEMORY_REFERENCE_BUDGET_IMPOSSIBLE");
  const scoped = context.dependencies.scopedMemoryReferenceOptions;
  if (scoped !== undefined && context.dependencies.memoryReferenceOptions !== undefined) {
    throw new JarvisError("MEMORY_REFERENCE_CONFIG_AMBIGUOUS");
  }
  const runtime = scoped === undefined
    ? createProductionMemoryReference(context.db, { ...context.dependencies.memoryReferenceOptions,
      clock: () => commandNow(context) })
    : createProductionScopedMemory(context.db, { ...scoped, clock: () => commandNow(context) });
  try {
    const prepared = await runtime.reader.read(context.argument,
      { max_records: count, max_record_bytes: 4096, max_bytes: maximum - overhead }, runtime.close);
    const response = { ok: true, command: "memory.context", context: prepared.payload,
      context_digest: prepared.digest, context_bytes: prepared.bytes,
      provider_status_received_at: prepared.provider_status_received_at };
    if (Buffer.byteLength(`${JSON.stringify({ version: 1, ...response })}\n`) > maximum) {
      throw new JarvisError("MEMORY_REFERENCE_BUDGET_IMPOSSIBLE");
    }
    return response;
  } catch (error) {
    // A successful read already awaited close before its final policy check.
    // On earlier failure, release resources without replacing the primary error.
    await runtime.close().catch(() => undefined);
    if (error instanceof MemoryReferenceError) throw new JarvisError(error.code);
    throw error;
  }
}
