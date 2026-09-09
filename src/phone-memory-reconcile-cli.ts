import { isAbsolute } from "node:path";
import type { PhoneMemoryReconcileOptions } from "./phone-memory-reconcile.js";
import { PhoneGatewayError, PHONE_ERROR_CODES } from "./phone-gateway-protocol.js";

export const PHONE_RECONCILE_CLI_FIELDS = ["reconcile-db", "reconcile-agent", "reconcile-policy", "reconcile-provider",
  "reconcile-signing-key", "reconcile-private-key", "reconcile-spool", "reconcile-dispatch-spool", "reconcile-review-spool",
  "reconcile-launcher", "reconcile-provider-config", "reconcile-journal-contract", "reconcile-read-contract"] as const;

/** All-or-none explicit server routing. Credentials and live sessions are never
 * accepted as CLI labels or reconstructed from files. Existing context stays separate. */
export function parsePhoneMemoryReconcileCli(values: Readonly<Record<string, unknown>>): PhoneMemoryReconcileOptions | undefined {
  if (PHONE_RECONCILE_CLI_FIELDS.every(key => values[key] === undefined)) return undefined;
  const fields: Record<string, string> = {};
  for (const name of PHONE_RECONCILE_CLI_FIELDS) {
    const value = values[name];
    if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")
      || [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
      throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
    fields[name] = value;
    if (!["reconcile-agent", "reconcile-provider", "reconcile-signing-key"].includes(name) && !isAbsolute(value))
      throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  if (!/^agent:[A-Za-z0-9][A-Za-z0-9._:-]{0,121}$/.test(fields["reconcile-agent"]!))
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  for (const key of ["reconcile-provider", "reconcile-signing-key"])
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(fields[key]!)) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  const common = { launcherPath: fields["reconcile-launcher"]!, configPath: fields["reconcile-provider-config"]! };
  return { database_path: fields["reconcile-db"]!, agent_id: fields["reconcile-agent"]!, memory: {
    policy_path: fields["reconcile-policy"]!, spool_root: fields["reconcile-spool"]!,
    roots: { candidate_dispatch_spool_root: fields["reconcile-dispatch-spool"]!, candidate_review_spool_root: fields["reconcile-review-spool"]! },
    read_fence_config: { provider_instance_id: fields["reconcile-provider"]!, signing_key_id: fields["reconcile-signing-key"]!,
      private_key_path: fields["reconcile-private-key"]! },
    journal_transport_options: { ...common, contractPath: fields["reconcile-journal-contract"]! },
    completion_transport_options: { ...common, contractPath: fields["reconcile-read-contract"]! },
  } };
}
