import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { createConnection } from "node:net";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./jarvis-error.js";
import { readCandidateCredential } from "./integration/candidate-reader-credential.js";
import { parseCompanyJson, parseCompanyJsonBytes } from "./company-candidate-json.js";
import { companyMemoryRequestDigest, parseTransitionReadResponse } from "./company-transition-read.js";

const MAX_BYTES = 1_048_576;
const CALL_TIMEOUT_MS = 10_000;
const AUTHORITY_TTL_MS = 60_000;
const AUTHORITY_DOMAIN = "second-brain/company-memory-authority/v1\0";
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const contextSchema = z.object({
  provider_instance_id: identifier,
  workspace_id: z.uuid(),
  owner: identifier,
  agent_id: identifier,
  session_id: identifier,
  projects: z.array(identifier).max(128),
  policy_revision: identifier,
  deletion_sequence: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  deletion_set_root: digest,
  processor_principal_id: identifier,
}).strict();

const clientConfigSchema = z.object({
  schema_version: z.literal(1),
  role: z.enum(["handoff", "processor"]),
  context: contextSchema,
  socket: z.string().min(1).max(107),
  signing_key_id: identifier,
  signing_key_file: z.string().min(1).max(4096),
}).strict().refine((value) => value.socket.startsWith("/")
  && value.signing_key_file.startsWith("/")
  && value.context.owner !== value.context.processor_principal_id);

export type CompanyContext = Readonly<{
  provider_instance_id: string;
  workspace_id: string;
  owner: string;
  agent_id: string;
  session_id: string;
  projects: readonly string[];
  policy_revision: string;
  deletion_sequence: number;
  deletion_set_root: string;
  processor_principal_id: string;
}>;

export type CompanyOperation = "handoff" | "accept" | "reject" | "mark_processed" | "read_transition_receipt";

export interface CompanyClient {
  readonly context: CompanyContext;
  readonly publicKeyPem: string;
  readonly keyId: string;
  call(operation: CompanyOperation, args: Record<string, unknown>, now?: Date, requestNonce?: string): Promise<unknown>;
}

const PURPOSE = {
  handoff: "company_memory_handoff",
  accept: "company_memory_accept",
  reject: "company_memory_reject",
  mark_processed: "company_memory_process",
  read_transition_receipt: "company_memory_receipt_read",
} as const;

function fail(code: string): never {
  throw new JarvisError(code);
}

function assertNever(value: never): never {
  void value;
  return fail("COMPANY_CANDIDATE_OPERATION_DENIED");
}

function allowed(role: "handoff" | "processor", operation: CompanyOperation): boolean {
  switch (role) {
    case "handoff":
      return operation === "handoff";
    case "processor":
      return operation === "accept" || operation === "reject" || operation === "mark_processed"
        || operation === "read_transition_receipt";
    default:
      return assertNever(role);
  }
}

function requestDigest(operation: CompanyOperation, args: Record<string, unknown>): string {
  return companyMemoryRequestDigest(operation, args);
}

export function createCompanyClient(configPath: string, role: "handoff" | "processor"): CompanyClient {
  let rawConfig: unknown;
  try {
    rawConfig = parseCompanyJson(readCandidateCredential(configPath));
  } catch (error) {
    if (error instanceof JarvisError && error.code === "CANDIDATE_READER_CREDENTIAL_INVALID") {
      fail("COMPANY_CANDIDATE_CREDENTIAL_INVALID");
    }
    if (error instanceof SyntaxError) fail("COMPANY_CANDIDATE_CONFIG_INVALID");
    throw error;
  }
  const parsed = clientConfigSchema.safeParse(rawConfig);
  if (!parsed.success || parsed.data.role !== role) fail("COMPANY_CANDIDATE_CONFIG_INVALID");
  const config = parsed.data;
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(readCandidateCredential(config.signing_key_file));
  } catch (error) {
    if (error instanceof JarvisError && error.code !== "CANDIDATE_READER_CREDENTIAL_INVALID") throw error;
    fail("COMPANY_CANDIDATE_CREDENTIAL_INVALID");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("COMPANY_CANDIDATE_CREDENTIAL_INVALID");
  const exported = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  if (typeof exported !== "string") fail("COMPANY_CANDIDATE_CREDENTIAL_INVALID");
  const context: CompanyContext = config.context;

  return {
    context,
    publicKeyPem: exported,
    keyId: config.signing_key_id,
    call(operation, args, now = new Date(), requestNonce = `jarvis:${randomUUID()}`) {
      if (!allowed(config.role, operation)) fail("COMPANY_CANDIDATE_OPERATION_DENIED");
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        fail("COMPANY_CANDIDATE_REQUEST_INVALID");
      }
      if (Number.isNaN(now.getTime())) fail("COMPANY_CANDIDATE_REQUEST_INVALID");
      if (!identifier.safeParse(requestNonce).success) fail("COMPANY_CANDIDATE_REQUEST_INVALID");
      const principalId = config.role === "handoff"
        ? context.owner
        : context.processor_principal_id;
      let request = "";
      let lookupNonce = "";
      let lookupDigest = "";
      try {
        const unsignedAuthority = {
          schema_version: 1,
          provider_instance_id: context.provider_instance_id,
          workspace_id: context.workspace_id,
          principal_id: principalId,
          agent_id: context.agent_id,
          session_id: context.session_id,
          projects: [...context.projects],
          policy_revision: context.policy_revision,
          deletion_sequence: context.deletion_sequence,
          deletion_set_root: context.deletion_set_root,
          purpose: PURPOSE[operation],
          operation,
          request_digest: requestDigest(operation, args),
          issued_at: now.toISOString(),
          expires_at: new Date(now.getTime() + AUTHORITY_TTL_MS).toISOString(),
          nonce: requestNonce,
          signing_key_id: config.signing_key_id,
        };
        const signature = sign(null, Buffer.from(
          `${AUTHORITY_DOMAIN}${canonicalize(unsignedAuthority)}`,
        ), privateKey).toString("base64url");
        lookupNonce = unsignedAuthority.nonce;
        lookupDigest = unsignedAuthority.request_digest;
        request = canonicalize({
          authority: { ...unsignedAuthority, signature },
          arguments: args,
        });
      } catch (error) {
        if (error instanceof JarvisError) throw error;
        fail("COMPANY_CANDIDATE_REQUEST_INVALID");
      }
      if (Buffer.byteLength(request) > MAX_BYTES) fail("COMPANY_CANDIDATE_REQUEST_INVALID");

      return new Promise((resolve, reject) => {
        const socket = createConnection({ path: config.socket, allowHalfOpen: true });
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let settled = false;
        const finish = (error?: JarvisError, result?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          if (error) reject(error);
          else resolve(result);
        };
        const timer = setTimeout(() => finish(new JarvisError("COMPANY_CANDIDATE_CALL_TIMEOUT")), CALL_TIMEOUT_MS);
        socket.on("connect", () => socket.end(request));
        socket.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_BYTES) finish(new JarvisError("COMPANY_CANDIDATE_RESPONSE_INVALID"));
          else chunks.push(chunk);
        });
        socket.on("end", () => {
          let raw: unknown;
          try {
            raw = parseCompanyJsonBytes(Buffer.concat(chunks));
            if (raw === undefined) throw new JarvisError("COMPANY_CANDIDATE_RESPONSE_INVALID");
          } catch (error) {
            if (error instanceof JarvisError) finish(error);
            else finish(new JarvisError("COMPANY_CANDIDATE_RESPONSE_INVALID"));
            return;
          }
          if (typeof raw === "object" && raw !== null && "error" in raw) {
            finish(new JarvisError("COMPANY_CANDIDATE_CALL_REFUSED"));
            return;
          }
          if (operation === "read_transition_receipt") {
            try {
              finish(undefined, parseTransitionReadResponse(raw, {
                provider_instance_id: context.provider_instance_id,
                workspace_id: context.workspace_id,
                selector: args,
                lookup_nonce: lookupNonce,
                lookup_request_digest: lookupDigest,
              }));
            } catch (error) {
              finish(error instanceof JarvisError ? error : new JarvisError("COMPANY_SB_RECEIPT_INVALID"));
            }
            return;
          }
          finish(undefined, raw);
        });
        socket.on("error", () => finish(new JarvisError("COMPANY_CANDIDATE_CALL_REFUSED")));
      });
    },
  };
}
