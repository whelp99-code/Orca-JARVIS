import { CommandModelTransport } from "./context-model-transport.js";
import type { MemoryReferenceProductionOptions } from "./memory-reference-production.js";
import type { MemoryWithdrawalProductionOptions } from "./memory-withdrawal-production.js";

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

/**
 * Host composition: the provider this deployment reads through when it plans a withdrawal.
 *
 * It names no signing material. The composition reads the provisioned memory-effect identity
 * itself, so a deployment that configured a provider but provisioned no key is refused with
 * MEMORY_EFFECT_SIGNING_KEY_UNCONFIGURED instead of minting one for this process.
 */
export function hostMemoryWithdrawalOptions(
  env: NodeJS.ProcessEnv = process.env,
): MemoryWithdrawalProductionOptions | undefined {
  const launcher = env["JARVIS_SECOND_BRAIN_LAUNCHER"];
  const provider = env["JARVIS_MEMORY_PROVIDER_INSTANCE_ID"];
  if (launcher === undefined || launcher.length === 0
    || provider === undefined || provider.length === 0) return undefined;
  return { provider_instance_id: provider,
    transport_options: { launcherPath: launcher, configPath: env["JARVIS_SECOND_BRAIN_CONFIG"] } };
}

export async function readProcessStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
