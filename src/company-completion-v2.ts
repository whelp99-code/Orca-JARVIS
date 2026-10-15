import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { parseCompanyJson } from "./company-candidate-json.js";
import { readCandidateCredential } from "./integration/candidate-reader-credential.js";
import { JarvisError } from "./jarvis-error.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const configSchema = z.object({
  schema_version: z.literal(2),
  executable: z.string().startsWith("/"),
  args: z.array(z.string().max(4096)).max(16),
}).strict();
export const companyCompletionV2Schema = z.object({
  schema_version: z.literal(2),
  state: z.literal("completed"),
  request_id: z.string(),
  command_digest: digest,
  candidate_id: z.string(),
  content_digest: digest,
  acceptance_receipt_digest: digest,
  effect_digest: digest,
}).strict();
export type CompanyCompletionV2 = z.infer<typeof companyCompletionV2Schema>;

export type CompanyCompletionCommand = {
  request_id: string;
  target: { candidate_id: string; content_digest: string };
};
export type CompanyCompletionAcceptance = {
  receipt_digest: string;
  operation: "accept";
  state: "accepted";
  handoff_id: string;
  receipt_id: string;
};

export interface CompanyCompletionVerifierV2 {
  readonly version: 2;
  verify(command: CompanyCompletionCommand, acceptance: CompanyCompletionAcceptance, commandDigest: string): Promise<CompanyCompletionV2>;
}

export function assertPinnedCompanyExecutable(executable: string): void {
  const uid = process.getuid?.();
  const info = lstatSync(executable);
  if (realpathSync(executable) !== executable || !info.isFile()
    || (info.uid !== uid && info.uid !== 0)
    || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) {
    throw new JarvisError("COMPANY_COMPLETION_CONFIG_INVALID");
  }
  for (let parent = dirname(executable);; parent = dirname(parent)) {
    const directory = lstatSync(parent);
    if (!directory.isDirectory() || (directory.uid !== uid && directory.uid !== 0)
      || ((directory.mode & 0o022) !== 0 && (directory.mode & 0o1000) === 0)) {
      throw new JarvisError("COMPANY_COMPLETION_CONFIG_INVALID");
    }
    if (parent === "/") break;
  }
}

export function companyCompletionConfigVersion(path: string): 1 | 2 {
  const parsed = z.object({ schema_version: z.union([z.literal(1), z.literal(2)]) }).safeParse(
    parseCompanyJson(readCandidateCredential(path)),
  );
  if (!parsed.success) throw new JarvisError("COMPANY_COMPLETION_CONFIG_INVALID");
  return parsed.data.schema_version;
}

export function createCompanyCompletionVerifierV2(path: string): CompanyCompletionVerifierV2 {
  const parsed = configSchema.safeParse(parseCompanyJson(readCandidateCredential(path)));
  if (!parsed.success) throw new JarvisError("COMPANY_COMPLETION_CONFIG_INVALID");
  const config = parsed.data;
  try {
    assertPinnedCompanyExecutable(config.executable);
  } catch (error) {
    if (error instanceof JarvisError) throw error;
    throw new JarvisError("COMPANY_COMPLETION_CONFIG_INVALID");
  }
  return {
    version: 2 as const,
    verify(command, acceptance, commandDigest) {
      return new Promise((resolve, reject) => {
        let stdinFailed = false;
        const child = execFile(config.executable, [...config.args], {
          shell: false, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1_048_576, encoding: "utf8",
          env: { PATH: "/usr/bin:/bin" },
        }, (error, stdout) => {
          if (error || stdinFailed) { reject(new JarvisError("COMPANY_VERIFIER_INVALID")); return; }
          const result = companyCompletionV2Schema.safeParse(parseCompanyJson(stdout));
          if (!result.success || result.data.request_id !== command.request_id
            || result.data.command_digest !== commandDigest
            || result.data.candidate_id !== command.target.candidate_id
            || result.data.content_digest !== command.target.content_digest
            || result.data.acceptance_receipt_digest !== acceptance.receipt_digest
            || result.data.effect_digest === commandDigest
            || result.data.effect_digest === command.target.content_digest
            || result.data.effect_digest === acceptance.receipt_digest) {
            reject(new JarvisError("COMPANY_VERIFIER_INVALID"));
            return;
          }
          resolve(result.data);
        });
        child.stdin?.on("error", () => {
          stdinFailed = true;
          child.kill("SIGKILL");
        });
        child.stdin?.end(canonicalize({
          schema_version: 2,
          command,
          acceptance: {
            receipt_id: acceptance.receipt_id, receipt_digest: acceptance.receipt_digest,
            operation: "accept", state: "accepted", handoff_id: acceptance.handoff_id,
          },
        }));
      });
    },
  };
}
