import { z } from "zod";
import { JarvisError } from "../jarvis-error.js";
import { readCandidateCredential } from "./candidate-reader-credential.js";
import { crmCandidateMetadataSchema, MAIL_CANDIDATE_RECENT_LIMIT,
  type NativeCrmCandidateRead } from "./mail-candidates-contract.js";
import { priceHttpExchange, type PriceHttpExchange } from "./price-finance-production.js";

const settingsSchema = z.object({
  base_url: z.url(), key_file: z.string().min(1), workspace_id: z.uuid(), principal: z.string().min(1).max(256),
}).strict().refine(value => {
  const url = new URL(value.base_url);
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/"
    && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
});
const countSchema = z.object({ workspaceId: z.uuid(), count: z.int().nonnegative() }).strict();
const listSchema = countSchema.extend({ candidates: z.array(crmCandidateMetadataSchema) }).strict()
  .refine(value => value.count === value.candidates.length
    && new Set(value.candidates.map(row => row.id)).size === value.count);
export type CrmCandidateReaderSettings = z.infer<typeof settingsSchema>;
export type CrmCandidateReader = Readonly<{
  workspace_id: string;
  read(signal: AbortSignal): Promise<NativeCrmCandidateRead>;
}>;

export function createCrmCandidateReader(
  settings: CrmCandidateReaderSettings, exchange: PriceHttpExchange = priceHttpExchange,
): CrmCandidateReader {
  const parsed = settingsSchema.safeParse(settings);
  if (!parsed.success) throw new JarvisError("CRM_CANDIDATE_READER_CONFIG_INVALID");
  const config = parsed.data;
  const key = readCandidateCredential(config.key_file).trim();
  if (!/^[\x21-\x7e]{16,8192}$/.test(key)) throw new JarvisError("CANDIDATE_READER_CREDENTIAL_INVALID");
  const headers = { accept: "application/json", "x-api-key": key, "x-workspace-id": config.workspace_id,
    "x-principal-id": config.principal, "x-principal-kind": "service" };
  return {
    workspace_id: config.workspace_id,
    async read(signal) {
      signal.throwIfAborted();
      const [list, total] = await Promise.all([
        exchange({ method: "GET", url: new URL("/api/cwos/v2/mail-candidates", config.base_url), headers }),
        exchange({ method: "GET", url: new URL("/api/cwos/v2/mail-candidates/count", config.base_url), headers }),
      ]);
      signal.throwIfAborted();
      if (list.status !== 200 || total.status !== 200) throw new JarvisError("CRM_CANDIDATE_READ_REFUSED");
      let rawList: unknown;
      let rawTotal: unknown;
      try { rawList = JSON.parse(list.body); rawTotal = JSON.parse(total.body); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new JarvisError("CRM_CANDIDATE_RESPONSE_INVALID");
      }
      const candidates = listSchema.safeParse(rawList);
      const counted = countSchema.safeParse(rawTotal);
      if (!candidates.success || !counted.success) throw new JarvisError("CRM_CANDIDATE_RESPONSE_INVALID");
      if (candidates.data.workspaceId !== config.workspace_id || counted.data.workspaceId !== config.workspace_id) {
        throw new JarvisError("CRM_CANDIDATE_SCOPE_DENIED");
      }
      if (candidates.data.count !== counted.data.count) throw new JarvisError("CRM_CANDIDATE_SNAPSHOT_CHANGED");
      return {
        state: "read", workspace_id: config.workspace_id, candidate_count: candidates.data.count,
        recent: [...candidates.data.candidates].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
          .slice(0, MAIL_CANDIDATE_RECENT_LIMIT),
      };
    },
  };
}
