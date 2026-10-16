import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { parseCompanyJsonBytes } from "./company-candidate-json.js";
import { loadCompanyFreshnessClient } from "./company-freshness-client-config.js";
import { readCompanyProgressEvidence } from "./company-progress-evidence.js";
import { companyPublicKeyFingerprint } from "./company-approver-contract.js";
import {
  freshnessReadRequestSchema, freshnessReadResponseSchema, reserveProgressRequestSchema, reserveProgressResponseSchema,
  finishProgressRequestSchema, finishProgressResponseSchema,
  type CompanyFreshnessProvider, type FreshnessReadRequest, type FreshnessReadResponse,
  type ReserveProgressRequest, type ReserveProgressResponse, type FinishProgressRequest, type FinishProgressResponse,
} from "./company-freshness.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";

const MAX_BYTES = 1_048_576;
const HELPER = fileURLToPath(new URL("./company-freshness-transport-main.mjs", import.meta.url));
type Method = "read_freshness" | "reserve_progress" | "finish_progress";
type Request = FreshnessReadRequest | ReserveProgressRequest | FinishProgressRequest;
const evidenceRowSchema = z.object({ evidence_json: z.string(), evidence_digest: z.string() });
const required = () => ({ schema_version: 2, outcome: "error", code: "COMPANY_FRESHNESS_REQUIRED" } as const);

function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new JarvisError("COMPANY_CONTRACT_INVALID");
  return parsed.data;
}

function sameScope(left: Request["scope"], right: Request["scope"]): boolean {
  return left.provider_instance_id === right.provider_instance_id && left.workspace_id === right.workspace_id;
}

export class CompanyDbFreshness implements CompanyFreshnessProvider {
  readonly kind = "sb_company_db" as const;
  readonly publicKeyPem: string;
  readonly keyId: string;
  constructor(private readonly configPath: string, private readonly authority?: AuthorityDb) {
    const client = loadCompanyFreshnessClient(configPath);
    this.publicKeyPem = client.publicKeyPem;
    this.keyId = client.config.signing_key_id;
    if (authority) {
      const keys = z.array(z.object({ key_id: z.string(), public_key_pem: z.string() })).parse(
        authority.db.prepare("SELECT key_id,public_key_pem FROM trusted_authority_keys").all(),
      );
      const fingerprint = companyPublicKeyFingerprint(this.publicKeyPem);
      if (keys.some(key => key.key_id === this.keyId || companyPublicKeyFingerprint(key.public_key_pem) === fingerprint)) {
        throw new JarvisError("COMPANY_CREDENTIAL_NOT_SEPARATE");
      }
    }
  }

  readFreshness(value: FreshnessReadRequest): FreshnessReadResponse {
    const request = parseRequest(freshnessReadRequestSchema, value);
    try {
      const response = freshnessReadResponseSchema.parse(this.exchange("read_freshness", request, null));
      if (response.challenge === request.challenge && sameScope(response.scope, request.scope)) return response;
    } catch (error) { if (!(error instanceof Error)) throw error; }
    return { schema_version: 2, scope: request.scope, challenge: request.challenge, status: "unavailable", checkpoint: null };
  }

  reserveProgress(value: ReserveProgressRequest): ReserveProgressResponse {
    const request = parseRequest(reserveProgressRequestSchema, value);
    if (!this.authority) return required();
    try {
      const response = reserveProgressResponseSchema.parse(this.exchange("reserve_progress", request, null));
      if (response.outcome === "error"
        || (response.challenge === request.challenge && sameScope(response.scope, request.scope))) return response;
    } catch (error) { if (!(error instanceof Error)) throw error; }
    return required();
  }

  finishProgress(value: FinishProgressRequest): FinishProgressResponse {
    const request = parseRequest(finishProgressRequestSchema, value);
    if (!this.authority) return required();
    try {
      const row = evidenceRowSchema.parse(this.authority.db.prepare(
        "SELECT evidence_json,evidence_digest FROM company_progress_evidence_outbox WHERE operation_id=?",
      ).get(request.operation_id));
      if (row.evidence_digest !== request.evidence_digest) return required();
      const evidence = readCompanyProgressEvidence(this.authority, request.operation_id);
      const response = finishProgressResponseSchema.parse(this.exchange("finish_progress", request, evidence));
      if (response.outcome === "error") return response;
      if (response.challenge !== request.challenge || !sameScope(response.scope, request.scope)) return required();
      return response;
    } catch (error) { if (!(error instanceof Error)) throw error; }
    return required();
  }

  private exchange(method: Method, request: Request, evidence: unknown): unknown {
    if (this.authority?.db.inTransaction) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    const helper = lstatSync(HELPER);
    if (!helper.isFile() || helper.isSymbolicLink() || (helper.mode & 0o022) !== 0
      || (helper.uid !== process.getuid?.() && helper.uid !== 0)) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    const input = canonicalize({ schema_version: 1, method, request, evidence });
    if (Buffer.byteLength(input) > MAX_BYTES) throw new JarvisError("COMPANY_CONTRACT_INVALID");
    const stdout = execFileSync(process.execPath, [HELPER, "--config", this.configPath], {
      input: Buffer.from(input, "utf8"), encoding: null, shell: false, timeout: 10_000, killSignal: "SIGKILL",
      maxBuffer: MAX_BYTES, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: userInfo().homedir },
    });
    if (stdout.length === 0 || stdout.length > MAX_BYTES) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    return parseCompanyJsonBytes(stdout);
  }
}
