import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { companyPublicKeyFingerprint } from "./company-approver-contract.js";
import { createCompanyClient } from "./company-candidate-transport.js";
import { assertCompanyKeySeparation, pullCompanyCandidates } from "./company-candidate-import.js";
import { CompanyDailyReportCycle } from "./company-daily-report-cycle.js";
import type { CompanyFreshnessProvider } from "./company-freshness.js";
import { CompanyInternalClient } from "./company-internal-client.js";
import { CompanySbReportSource } from "./company-sb-report-source.js";
import { parseCompanyJson } from "./company-candidate-json.js";
import { readCompanyFreshnessCredential } from "./company-freshness-client-config.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";

const path = z.string().min(1).max(4096).startsWith("/");
const configSchema = z.discriminatedUnion("enabled", [
  z.object({ schema_version: z.literal(1), enabled: z.literal(false) }).strict(),
  z.object({ schema_version: z.literal(1), enabled: z.literal(true),
    activation_cutoff: z.iso.datetime({ precision: 3 }), report_client_config_file: path,
    auto_client_config_file: path.optional(), handoff_client_config_file: path.optional(),
  }).strict().refine(config => config.auto_client_config_file === undefined || config.handoff_client_config_file !== undefined),
]);
type Config = Extract<z.infer<typeof configSchema>, { enabled: true }>;
function readConfig(path: string | undefined): z.infer<typeof configSchema> {
  const parsed = configSchema.safeParse(path === undefined ? { schema_version: 1, enabled: false }
    : parseCompanyJson(readCompanyFreshnessCredential(path)));
  if (!parsed.success) throw new JarvisError("COMPANY_CALLER_CONFIG_INVALID");
  return parsed.data;
}
export function configuredCompanyDailyReport(db: AuthorityDb, path: string): CompanyDailyReportCycle {
  const config = readConfig(path);
  if (!config.enabled) throw new JarvisError("COMPANY_REPORT_UNAVAILABLE");
  return reportCycle(db, config);
}
function reportCycle(db: AuthorityDb, config: Config): CompanyDailyReportCycle {
  const client = new CompanyInternalClient(config.report_client_config_file, db);
  return new CompanyDailyReportCycle(db, { enabled: true, scope: client.scope,
    activation_cutoff: config.activation_cutoff, source: new CompanySbReportSource(client) });
}

/** One scope, one bounded evaluation/import per minute; the existing dashboard owns the tick. */
export function configuredCompanyInternalRuntime(db: AuthorityDb, path: string | undefined, freshness: CompanyFreshnessProvider,
  clock: () => Date, publish: () => void, log: (code: string) => void) {
  const config = readConfig(path);
  if (!config.enabled) return undefined;
  const reports = reportCycle(db, config);
  const auto = config.auto_client_config_file === undefined ? undefined : new CompanyInternalClient(config.auto_client_config_file, db);
  const report = new CompanyInternalClient(config.report_client_config_file, db);
  const handoff = config.handoff_client_config_file === undefined ? undefined : createCompanyClient(config.handoff_client_config_file, "handoff");
  if (auto !== undefined && canonicalize(auto.scope) !== canonicalize(report.scope)) throw new JarvisError("COMPANY_CALLER_CONFIG_INVALID");
  if (handoff !== undefined) {
    for (const internal of [auto, report]) {
      if (internal !== undefined && (internal.keyId === handoff.keyId
        || companyPublicKeyFingerprint(internal.publicKeyPem) === companyPublicKeyFingerprint(handoff.publicKeyPem))) {
        throw new JarvisError("COMPANY_CREDENTIAL_NOT_SEPARATE");
      }
    }
    assertCompanyKeySeparation(db, handoff, freshness);
    if (handoff.context.provider_instance_id !== report.scope.provider || handoff.context.workspace_id !== report.scope.workspace) {
      throw new JarvisError("COMPANY_CALLER_CONFIG_INVALID");
    }
  }
  let active: Promise<void> | undefined;
  let slot: number | undefined;
  const failed = (error: unknown) => log(error instanceof JarvisError ? error.code : "COMPANY_REPORT_UNAVAILABLE");
  return {
    tick(): void {
      const now = clock();
      const current = Math.floor(now.getTime() / 60_000);
      if (active !== undefined || slot === current) return;
      slot = current;
      active = (async () => {
        // A failed trigger never turns a protected candidate into an automatic approval.
        try { auto?.trigger(); } catch (error) { failed(error); }
        if (handoff !== undefined) {
          try { await pullCompanyCandidates(db, handoff, 100, 0, clock); } catch (error) { failed(error); }
        }
        try {
          const result = reports.publishDue(now);
          if (result.status === "conflict") log("COMPANY_REPORT_DIGEST_CONFLICT");
          if (result.status === "published") publish();
        } catch (error) { failed(error); }
        publish();
      })().finally(() => { active = undefined; });
    },
    async close(): Promise<void> { await active; },
  };
}
