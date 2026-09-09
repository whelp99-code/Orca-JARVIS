import { isAbsolute } from "node:path";
import { AuthorityDb } from "./db.js";
import type { PhoneMemoryProviderVerifierOptions } from "./phone-memory-provider-verifier.js";
import { PhoneGatewayError, PHONE_ERROR_CODES } from "./phone-gateway-protocol.js";

export const PHONE_PROVIDER_CLI_FIELDS = ["provider-verify-db", "provider-verify-agent", "provider-verify-policy",
  "provider-verify-provider", "provider-verify-spool", "provider-verify-dispatch-spool", "provider-verify-review-spool"] as const;
export type PhoneMemoryProviderCliOptions = Omit<PhoneMemoryProviderVerifierOptions, "authority"> & {
  readonly database_path: string;
};

export function parsePhoneMemoryProviderCli(values: Readonly<Record<string, unknown>>): PhoneMemoryProviderCliOptions | undefined {
  if (PHONE_PROVIDER_CLI_FIELDS.every(key => values[key] === undefined)) return undefined;
  const fields: Record<string, string> = {};
  for (const name of PHONE_PROVIDER_CLI_FIELDS) {
    const value = values[name];
    if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")
      || [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
      throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
    fields[name] = value;
    if (!["provider-verify-agent", "provider-verify-provider"].includes(name) && !isAbsolute(value))
      throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  if (!/^agent:[A-Za-z0-9][A-Za-z0-9._:-]{0,121}$/.test(fields["provider-verify-agent"]!)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(fields["provider-verify-provider"]!))
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  return { database_path: fields["provider-verify-db"]!, agent_id: fields["provider-verify-agent"]!,
    policy_path: fields["provider-verify-policy"]!, provider_instance_id: fields["provider-verify-provider"]!,
    spool_root: fields["provider-verify-spool"]!, roots: { dispatch: fields["provider-verify-dispatch-spool"]!,
      review: fields["provider-verify-review-spool"]! } };
}

/** Own only this connection. Never initialize/migrate an authority or issue a session.
 * SQLite fileMustExist prevents a mistyped path from creating an empty authority. */
export function openPhoneMemoryProviderCli(config: PhoneMemoryProviderCliOptions) {
  const { database_path, ...options } = config;
  const authority = new AuthorityDb(database_path, undefined, { fileMustExist: true });
  let closed = false;
  return { options: { ...options, authority }, close: () => {
    if (closed) return; closed = true; authority.close();
  } };
}
