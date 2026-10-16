import type { CliCommandContext, CliValues } from "./cli-command-context.js";
import { commandNow } from "./cli-command-context.js";
import { createCompanyClient } from "./company-candidate-transport.js";
import { assertCompanyKeySeparation, pullCompanyCandidates } from "./company-candidate-import.js";
import { configuredCompanyFreshness } from "./company-freshness-config.js";
import { CompanyCandidateExecutor, createCompanyCompletionVerifier } from "./company-candidate-execution.js";
import { companyCompletionConfigVersion, createCompanyCompletionVerifierV2 } from "./company-completion-v2.js";
import { JarvisError } from "./jarvis-error.js";

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
