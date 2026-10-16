import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { readCandidateCredential } from "./integration/candidate-reader-credential.js";
import { parseCompanyJson } from "./company-candidate-json.js";
import { JarvisError } from "./jarvis-error.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const absolutePath = z.string().min(1).max(4096).startsWith("/");
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const companyFreshnessClientConfigSchema = z.object({
  schema_version: z.literal(2),
  role: z.literal("freshness"),
  socket: z.string().min(1).max(107).startsWith("/"),
  signing_key_id: identifier,
  signing_key_file: absolutePath,
  context: z.object({
    provider_instance_id: identifier, workspace_id: z.uuid(),
    principal_id: z.literal("principal:jarvis-company-progress"),
    agent_id: identifier, session_id: identifier, projects: z.array(identifier).max(128),
    policy_revision: identifier, deletion_sequence: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    deletion_set_root: digest,
  }).strict(),
}).strict();

export type CompanyFreshnessClientConfig = z.infer<typeof companyFreshnessClientConfigSchema>;

/** The progress key is separate from human/processor authority and stays in its private directory. */
export function readCompanyFreshnessCredential(path: string): string {
  try {
    const value = readCandidateCredential(path);
    for (let parent = dirname(path);; parent = dirname(parent)) {
      const info = lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink()
        || (info.uid !== process.getuid?.() && info.uid !== 0)
        || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
        || (parent === dirname(path) && ((info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()))) {
        throw new JarvisError("COMPANY_FRESHNESS_CREDENTIAL_INVALID");
      }
      if (parent === "/") return value;
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new JarvisError("COMPANY_FRESHNESS_CREDENTIAL_INVALID");
  }
}

export function loadCompanyFreshnessClient(path: string): Readonly<{
  config: CompanyFreshnessClientConfig; privateKey: KeyObject; publicKeyPem: string;
}> {
  let raw: unknown;
  try { raw = parseCompanyJson(readCompanyFreshnessCredential(path)); }
  catch (error) {
    if (error instanceof JarvisError) throw error;
    throw new JarvisError("COMPANY_FRESHNESS_CONFIG_INVALID");
  }
  const parsed = companyFreshnessClientConfigSchema.safeParse(raw);
  if (!parsed.success) throw new JarvisError("COMPANY_FRESHNESS_CONFIG_INVALID");
  const config = parsed.data;
  let privateKey: KeyObject;
  try { privateKey = createPrivateKey(readCompanyFreshnessCredential(config.signing_key_file)); }
  catch (error) {
    if (error instanceof JarvisError) throw error;
    throw new JarvisError("COMPANY_FRESHNESS_CREDENTIAL_INVALID");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new JarvisError("COMPANY_FRESHNESS_CREDENTIAL_INVALID");
  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  if (typeof publicKeyPem !== "string") throw new JarvisError("COMPANY_FRESHNESS_CREDENTIAL_INVALID");
  return { config, privateKey, publicKeyPem };
}
