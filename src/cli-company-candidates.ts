import type { CliCommandContext } from "./cli-command-context.js";
import { commandNow } from "./cli-command-context.js";
import { createCompanyClient } from "./company-candidate-transport.js";
import { pullCompanyCandidates } from "./company-candidate-import.js";
import { CompanyCandidateExecutor, createCompanyCompletionVerifier } from "./company-candidate-execution.js";
import { JarvisError } from "./jarvis-error.js";

/** Explicit one-shot operator pull/execute. No timer, automatic owner approval or bulk drain. */
export async function executeCompanyCandidates(context: CliCommandContext): Promise<Record<string, unknown> | undefined> {
  if (context.command !== "company-candidates") return undefined;
  const { values, argument, subcommand, db } = context;
  const config = values["company-config"];
  if (!config || context.fourth !== undefined) throw new JarvisError("COMPANY_CALLER_CONFIG_REQUIRED");
  if (subcommand === "import" && argument === undefined) {
    if (values["company-completion-config"] !== undefined) throw new JarvisError("COMPANY_CALLER_CONFIG_INVALID");
    const limit = values.limit === undefined ? 100 : Number(values.limit);
    return { ok: true, command: "company-candidates.import", ...await pullCompanyCandidates(
      db, createCompanyClient(config, "handoff"), limit, 0, () => commandNow(context),
    ) };
  }
  if (subcommand === "execute" && argument) {
    const completion = values["company-completion-config"];
    const executor = new CompanyCandidateExecutor(db, createCompanyClient(config, "processor"),
      completion ? createCompanyCompletionVerifier(completion) : undefined, () => commandNow(context));
    return { ok: true, command: "company-candidates.execute", execution: await executor.execute(argument) };
  }
  throw new JarvisError("COMPANY_CALLER_CONFIG_INVALID");
}
