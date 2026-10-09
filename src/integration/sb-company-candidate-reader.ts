import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { createConnection } from "node:net";
import { z } from "zod";
import { canonicalize } from "../canonical.js";
import { JarvisError } from "../jarvis-error.js";
import { readCandidateCredential } from "./candidate-reader-credential.js";
import type { NativeSbCandidateRead } from "./mail-candidates-contract.js";

const MAX_RESPONSE_BYTES = 1_048_576;
const READ_TIMEOUT_MS = 10_000;
const contextSchema = z.object({
  provider_instance_id: z.string().min(1).max(256),
  workspace_id: z.uuid(),
  principal_id: z.string().min(1).max(256),
  agent_id: z.string().min(1).max(256),
  session_id: z.string().min(1).max(256),
  projects: z.array(z.string().min(1).max(256)).max(128),
  policy_revision: z.string().min(1).max(256),
  deletion_sequence: z.int().nonnegative().safe(),
  deletion_set_root: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  socket: z.string().min(1).max(103),
  signing_key_file: z.string().min(1).max(4096),
  signing_key_id: z.string().min(1).max(256),
  purpose: z.literal("company_memory_read"),
  operation: z.literal("list_candidates"),
}).strict().refine(value => value.socket.startsWith("/")
  && value.socket.endsWith("/company-reader.sock")
  && value.signing_key_file.startsWith("/"));
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const responseSchema = z.object({
  candidates: z.array(z.object({
    candidate_id: z.string().min(1).max(2048),
    source_event_id: z.string().min(1).max(2048),
    content_digest: digest,
  }).strict()).max(1),
  count: z.int().nonnegative().safe(),
  limit: z.literal(1),
  offset: z.literal(0),
}).strict().refine(value => value.candidates.length === Math.min(value.count, 1));

type SbCandidateReader = Readonly<{
  workspace_id: string;
  read(signal: AbortSignal): Promise<NativeSbCandidateRead>;
}>;

function readerError(code: string): JarvisError {
  return new JarvisError(code);
}

export function createSbCompanyCandidateReader(clientPath: string): SbCandidateReader {
  let rawClient: unknown;
  try {
    rawClient = JSON.parse(readCandidateCredential(clientPath));
  } catch {
    throw readerError("SB_COMPANY_CANDIDATE_READER_CREDENTIAL_INVALID");
  }
  const parsed = contextSchema.safeParse(rawClient);
  if (!parsed.success) throw readerError("SB_COMPANY_CANDIDATE_READER_CONFIG_INVALID");
  const client = parsed.data;

  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(readCandidateCredential(client.signing_key_file));
  } catch {
    throw readerError("SB_COMPANY_CANDIDATE_READER_CREDENTIAL_INVALID");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw readerError("SB_COMPANY_CANDIDATE_READER_CREDENTIAL_INVALID");
  }

  return {
    workspace_id: client.workspace_id,
    read(signal) {
      if (signal.aborted) return Promise.reject(readerError("SB_COMPANY_CANDIDATE_READ_CANCELLED"));
      const arguments_ = { limit: 1, offset: 0 } as const;
      const issuedAt = new Date();
      const unsignedAuthority = {
        schema_version: 1,
        provider_instance_id: client.provider_instance_id,
        workspace_id: client.workspace_id,
        principal_id: client.principal_id,
        agent_id: client.agent_id,
        session_id: client.session_id,
        projects: client.projects,
        policy_revision: client.policy_revision,
        deletion_sequence: client.deletion_sequence,
        deletion_set_root: client.deletion_set_root,
        purpose: client.purpose,
        operation: client.operation,
        request_digest: `sha256:${createHash("sha256")
          .update("second-brain/company-memory-request/v1\0")
          .update(canonicalize({ operation: "list_candidates", arguments: arguments_ }))
          .digest("hex")}`,
        issued_at: issuedAt.toISOString(),
        expires_at: new Date(issuedAt.getTime() + 60_000).toISOString(),
        nonce: `jarvis:${randomUUID()}`,
        signing_key_id: client.signing_key_id,
      };
      const signature = sign(null, Buffer.from(
        `second-brain/company-memory-authority/v1\0${canonicalize(unsignedAuthority)}`,
      ), privateKey).toString("base64url");
      const request = canonicalize({
        authority: { ...unsignedAuthority, signature },
        arguments: arguments_,
      });

      return new Promise((resolve, reject) => {
        const socket = createConnection({ path: client.socket, allowHalfOpen: true });
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let settled = false;
        const finish = (error?: JarvisError, result?: NativeSbCandidateRead) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          socket.destroy();
          if (error) reject(error);
          else if (result) resolve(result);
          else reject(readerError("SB_COMPANY_CANDIDATE_RESPONSE_INVALID"));
        };
        const abort = () => finish(readerError("SB_COMPANY_CANDIDATE_READ_CANCELLED"));
        const timer = setTimeout(() => finish(readerError("SB_COMPANY_CANDIDATE_READ_TIMEOUT")), READ_TIMEOUT_MS);
        signal.addEventListener("abort", abort, { once: true });
        socket.on("connect", () => socket.end(request));
        socket.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            finish(readerError("SB_COMPANY_CANDIDATE_RESPONSE_INVALID"));
            return;
          }
          chunks.push(chunk);
        });
        socket.on("end", () => {
          let rawResponse: unknown;
          try {
            rawResponse = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
          } catch {
            finish(readerError("SB_COMPANY_CANDIDATE_RESPONSE_INVALID"));
            return;
          }
          if (typeof rawResponse === "object" && rawResponse !== null && "error" in rawResponse) {
            finish(readerError("SB_COMPANY_CANDIDATE_READ_REFUSED"));
            return;
          }
          const response = responseSchema.safeParse(rawResponse);
          if (!response.success) {
            finish(readerError("SB_COMPANY_CANDIDATE_RESPONSE_INVALID"));
            return;
          }
          finish(undefined, {
            state: "read",
            workspace_id: client.workspace_id,
            candidate_count: response.data.count,
          });
        });
        socket.on("error", () => finish(readerError("SB_COMPANY_CANDIDATE_READ_REFUSED")));
      });
    },
  };
}
