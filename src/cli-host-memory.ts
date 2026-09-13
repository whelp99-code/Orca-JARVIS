import { CommandModelTransport } from "./context-model-transport.js";
import type { MemoryReferenceProductionOptions } from "./memory-reference-production.js";

/** Host composition: a consumer command, not a file log. */
export function hostMemoryReferenceOptions(
  env: NodeJS.ProcessEnv = process.env,
): MemoryReferenceProductionOptions | undefined {
  const command = env["JARVIS_MODEL_TRANSPORT_CMD"];
  if (command === undefined || command.length === 0) return undefined;
  const rawArgs = env["JARVIS_MODEL_TRANSPORT_ARGS"];
  let args: string[] = [];
  if (rawArgs !== undefined && rawArgs.length > 0) {
    const parsed: unknown = JSON.parse(rawArgs);
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string")) {
      return undefined;
    }
    args = parsed;
  }
  return { model_transport: new CommandModelTransport(command, args) };
}

export async function readProcessStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
