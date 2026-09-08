import { isAbsolute } from "node:path";
import type { PhoneMemoryContextOptions } from "./phone-memory-context.js";
import { PhoneGatewayError, PHONE_ERROR_CODES } from "./phone-gateway-protocol.js";

export const PHONE_MEMORY_CLI_FIELDS = ["memory-db", "memory-agent", "memory-policy", "memory-provider",
  "memory-signing-key", "memory-private-key", "memory-projection-key", "memory-launcher",
  "memory-provider-config", "memory-contract"] as const;

/** Explicit all-or-none activation. No credentials or grants are inferred from env. */
export function parsePhoneMemoryContextCli(values: Readonly<Record<string, unknown>>): PhoneMemoryContextOptions | undefined {
  if (PHONE_MEMORY_CLI_FIELDS.every(name => values[name] === undefined)) return undefined;
  const fields: Record<string, string> = {};
  for (const name of PHONE_MEMORY_CLI_FIELDS) {
    const value = values[name];
    if (typeof value !== "string" || !value || value !== value.normalize("NFC") || [...value].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) {
      throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
    }
    fields[name] = value;
  }
  for (const name of PHONE_MEMORY_CLI_FIELDS) {
    if (["memory-agent", "memory-provider", "memory-signing-key"].includes(name)) continue;
    if (!isAbsolute(fields[name]!)) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  if (!/^agent:[A-Za-z0-9][A-Za-z0-9._:-]{0,121}$/.test(fields["memory-agent"]!)) {
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  for (const name of ["memory-provider", "memory-signing-key"]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(fields[name]!)) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  return { database_path: fields["memory-db"]!, agent_id: fields["memory-agent"]!, memory: {
    policy_path: fields["memory-policy"]!, projection_key_path: fields["memory-projection-key"]!,
    read_fence_config: { provider_instance_id: fields["memory-provider"]!, signing_key_id: fields["memory-signing-key"]!,
      private_key_path: fields["memory-private-key"]! },
    transport_options: { launcherPath: fields["memory-launcher"]!, configPath: fields["memory-provider-config"]!,
      contractPath: fields["memory-contract"]! },
  } };
}
