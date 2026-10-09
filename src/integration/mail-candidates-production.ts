import { JarvisError } from "../jarvis-error.js";
import { createCrmCandidateReader } from "./crm-candidate-reader.js";
import { createSbCompanyCandidateReader } from "./sb-company-candidate-reader.js";
import type { MailCandidatesSummary, NativeCrmCandidateRead, NativeSbCandidateRead } from "./mail-candidates-contract.js";

type CandidateReader<T> = Readonly<{ read(signal: AbortSignal): Promise<T> }>;
type Source<T> = CandidateReader<T> | Readonly<{ state: "unconnected"; reason: "unconfigured" | "refused" }>;
export type MailCandidatesRuntime = Readonly<{
  read(): Promise<MailCandidatesSummary>;
  close(): void;
}>;

/** Explicit consumer configuration only. Credentials stay in these backend readers. */
export function createMailCandidatesRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MailCandidatesRuntime {
  let crm: Source<NativeCrmCandidateRead>;
  const values = [env.JARVIS_CRM_CANDIDATE_READER_BASE_URL, env.JARVIS_CRM_CANDIDATE_READER_KEY_FILE,
    env.JARVIS_CRM_CANDIDATE_READER_WORKSPACE_ID, env.JARVIS_CRM_CANDIDATE_READER_PRINCIPAL];
  if (values.every(value => value === undefined)) crm = { state: "unconnected", reason: "unconfigured" };
  else {
    try {
      crm = createCrmCandidateReader({
        base_url: env.JARVIS_CRM_CANDIDATE_READER_BASE_URL ?? "",
        key_file: env.JARVIS_CRM_CANDIDATE_READER_KEY_FILE ?? "",
        workspace_id: env.JARVIS_CRM_CANDIDATE_READER_WORKSPACE_ID ?? "",
        principal: env.JARVIS_CRM_CANDIDATE_READER_PRINCIPAL ?? "",
      });
    } catch (error) {
      if (!(error instanceof JarvisError)) throw error;
      crm = { state: "unconnected", reason: "refused" };
    }
  }
  let sb: Source<NativeSbCandidateRead>;
  const clientPath = env.JARVIS_SB_COMPANY_CANDIDATE_READER_CLIENT_FILE;
  if (clientPath === undefined) sb = { state: "unconnected", reason: "unconfigured" };
  else {
    try { sb = createSbCompanyCandidateReader(clientPath); }
    catch (error) {
      if (!(error instanceof JarvisError)) throw error;
      sb = { state: "unconnected", reason: "refused" };
    }
  }
  const lifetime = new AbortController();
  async function readSource<T>(source: Source<T>): Promise<T | Readonly<{ state: "unconnected"; reason: "refused" | "unconfigured" }>> {
    if ("state" in source) return source;
    try { return await source.read(lifetime.signal); }
    catch (error) {
      if (!(error instanceof JarvisError) && !(error instanceof DOMException && error.name === "AbortError")) throw error;
      return { state: "unconnected", reason: "refused" };
    }
  }
  return {
    async read() {
      lifetime.signal.throwIfAborted();
      const [crmValue, sbValue] = await Promise.all([readSource(crm), readSource(sb)]);
      lifetime.signal.throwIfAborted();
      return { schema_version: 1, proof_level: "native-read", authority: "none",
        observed_at: new Date().toISOString(), crm: crmValue, sb: sbValue };
    },
    close() { lifetime.abort(); },
  };
}
