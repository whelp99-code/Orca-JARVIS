import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { companyPublicKeyFingerprint } from "./company-approver-contract.js";
import { parseCompanyJsonBytes } from "./company-candidate-json.js";
import { loadCompanyFreshnessClient } from "./company-freshness-client-config.js";
import { companyReportArgumentsSchema } from "./company-internal-envelope.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";

const HELPER = fileURLToPath(new URL("./company-freshness-transport-main.mjs", import.meta.url));
const MAX_BYTES = 1_048_576;
export type CompanyReportArguments = z.infer<typeof companyReportArgumentsSchema>;

/** Bounded evaluation/read only. No policy signer, human receipt, or content access. */
export class CompanyInternalClient {
  readonly scope: { readonly provider: string; readonly workspace: string };
  readonly keyId: string;
  readonly publicKeyPem: string;
  constructor(private readonly path: string, private readonly authority: AuthorityDb) {
    const client = loadCompanyFreshnessClient(path);
    this.keyId = client.config.signing_key_id;
    this.publicKeyPem = client.publicKeyPem;
    this.scope = { provider: client.config.context.provider_instance_id, workspace: client.config.context.workspace_id };
    const fingerprint = companyPublicKeyFingerprint(client.publicKeyPem);
    const keys = z.array(z.object({ key_id: z.string(), public_key_pem: z.string() })).parse(
      authority.db.prepare("SELECT key_id,public_key_pem FROM trusted_authority_keys").all());
    if (keys.some(key => key.key_id === client.config.signing_key_id
      || companyPublicKeyFingerprint(key.public_key_pem) === fingerprint)) throw new JarvisError("COMPANY_CREDENTIAL_NOT_SEPARATE");
  }
  trigger(): unknown {
    return this.call("auto_process_internal", { limit: 100 });
  }
  report(args: CompanyReportArguments): unknown {
    return this.call("read_auto_report", companyReportArgumentsSchema.parse(args));
  }
  private call(operation: "auto_process_internal" | "read_auto_report", args: object): unknown {
    if (this.authority.db.inTransaction) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    const helper = lstatSync(HELPER);
    if (!helper.isFile() || helper.isSymbolicLink() || (helper.mode & 0o022) !== 0
      || (helper.uid !== process.getuid?.() && helper.uid !== 0)) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    const stdout = execFileSync(process.execPath, [HELPER, "--config", this.path], {
      input: Buffer.from(canonicalize({ schema_version: 1, operation, arguments: args })), encoding: null,
      shell: false, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: MAX_BYTES,
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: userInfo().homedir },
    });
    if (stdout.length === 0 || stdout.length > MAX_BYTES) throw new JarvisError("COMPANY_CANDIDATE_RESPONSE_INVALID");
    const result = parseCompanyJsonBytes(stdout);
    if (typeof result !== "object" || result === null || "error" in result) throw new JarvisError("COMPANY_CANDIDATE_CALL_REFUSED");
    return result;
  }
}
