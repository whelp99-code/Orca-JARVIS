import { FileModelTransport } from "./context-model-transport.js";
import type { MemoryReferenceProductionOptions } from "./memory-reference-production.js";

/** Host composition for `jarvis memory postcompact` without test DI. */
export function hostMemoryReferenceOptions(
  env: NodeJS.ProcessEnv = process.env,
): MemoryReferenceProductionOptions | undefined {
  const path = env["JARVIS_MODEL_TRANSPORT_PATH"];
  if (path === undefined || path.length === 0) return undefined;
  return { model_transport: new FileModelTransport(path) };
}

export async function readProcessStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
