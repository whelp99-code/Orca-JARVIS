import type { CliCommandContext, CliValues } from "./cli-command-context.js";
import { commandNow } from "./cli-command-context.js";
import { createCompanyClient } from "./company-candidate-transport.js";
import { assertCompanyKeySeparation, pullCompanyCandidates } from "./company-candidate-import.js";
import { configuredCompanyFreshness } from "./company-freshness-config.js";
import { CompanyCandidateExecutor, createCompanyCompletionVerifier } from "./company-candidate-execution.js";
import { companyCompletionConfigVersion, createCompanyCompletionVerifierV2 } from "./company-completion-v2.js";
import { JarvisError } from "./jarvis-error.js";
import { configuredCompanyDailyReport } from "./company-internal-runtime.js";
import { kstCutoff } from "./company-daily-report-cycle.js";

const IMPORT_OPTIONS = ["db", "json", "company-config", "company-freshness-config", "limit"] as const;
const EXECUTE_OPTIONS = ["db", "json", "company-config", "company-completion-config", "company-freshness-config"] as const;

function rejectUnlisted(values: CliValues, allowed: readonly string[]): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && !allowed.includes(key)) throw new JarvisError("COMPANY_CALLER_CONFIG_INVALID");
  }
}

/** Explicit one-shot operator pull/execute. No timer, automatic owner approval or bulk drain. */
export async function executeCompanyCandidates(context: CliCommandContext): Promise<Record<string, unknown> | undefined> {
  if (context.command !== "company-candidates") return undefined;
  const { values, argument, subcommand, db } = context;
  const config = values["company-config"];
  if (!config || context.fourth !== undefined) throw new JarvisError("COMPANY_CALLER_CONFIG_REQUIRED");
  if (subcommand === "daily-report" && argument === undefined) {
    rejectUnlisted(values, ["db", "json", "company-config", "date"]);
    const date = values.date;
    if (values.db === undefined || date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new JarvisError("COMPANY_CALLER_CONFIG_INVALID");
    }
    const cutoff = new Date(kstCutoff(date));
    const now = commandNow(context);
    if (new Date(cutoff.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10) !== date
      || cutoff.getTime() > now.getTime()) throw new JarvisError("COMPANY_CALLER_CONFIG_INVALID");
    return { ok: true, command: "company-candidates.daily-report",
      report: configuredCompanyDailyReport(db, config).publishDue(cutoff, now) };
  }
  if (subcommand === "import" && argument === undefined) {
    rejectUnlisted(values, IMPORT_OPTIONS);
    const limit = values.limit === undefined ? 100 : Number(values.limit);
    const client = createCompanyClient(config, "handoff");
    assertCompanyKeySeparation(db, client, configuredCompanyFreshness(values["company-freshness-config"], db));
    return { ok: true, command: "company-candidates.import", ...await pullCompanyCandidates(
      db, client, limit, 0, () => commandNow(context),
    ) };
  }
  if (subcommand === "execute" && argument) {
    rejectUnlisted(values, EXECUTE_OPTIONS);
    const completion = values["company-completion-config"];
    const verifier = completion === undefined ? undefined
      : companyCompletionConfigVersion(completion) === 2
        ? createCompanyCompletionVerifierV2(completion)
        : createCompanyCompletionVerifier(completion);
    const executor = new CompanyCandidateExecutor(db, createCompanyClient(config, "processor"),
      verifier, () => commandNow(context), configuredCompanyFreshness(values["company-freshness-config"], db));
    return { ok: true, command: "company-candidates.execute", execution: await executor.execute(argument) };
  }
  throw new JarvisError("COMPANY_CALLER_CONFIG_INVALID");
}
