import { parseArgs } from "node:util";
import { statSync } from "node:fs";
import { readTaskPerformance, taskPerformanceWindow } from "./task-performance.js";
import { readTaskRoutingShadow } from "./task-routing-shadow.js";
import { readWorkRoutingPolicy } from "./cli-work-routing.js";
import { inspectRuntimeIdentity } from "./cli-runtime-identity.js";
import {
  type CliCommandContext,
  type CliCommandHandler,
  type CliDependencies,
  normalizeCliValues,
} from "./cli-command-context.js";
import { executeControlCommand } from "./cli-control-commands.js";
import { executeBootstrapCommand, executeCoreCommand } from "./cli-core-commands.js";
import { executeGjcCommand } from "./cli-gjc-commands.js";
import { executeDailyCommand } from "./cli-daily-commands.js";
import { executeWorkRouting, executeExecutorPlanValidation, executeTaskTemplateCompilation } from "./cli-work-routing.js";
import { taskTemplateCatalog } from "./task-templates.js";
import { inspectTaskExecutor, inspectTaskExecutors, probeTaskExecutor, probeTaskExecutorRuntime } from "./task-executor-registry.js";
import { executeLiveCommand } from "./cli-live-commands.js";
import { executePreGjcCommand } from "./cli-pre-gjc-commands.js";
import { executeStateCommand } from "./cli-state-commands.js";
import { readRemoteAuditHistory } from "./remote-audit-history.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { executeLocalTimeline, localTimelinePreflight } from "./cli-local-timeline.js";
import { hostMemoryReferenceOptions, hostMemoryWithdrawalOptions } from "./cli-host-memory.js";
import { executeReleaseGateCommand } from "./cli-release-commands.js";
import { tryExecuteSecondBrainReadinessCommand } from "./cli-readiness-commands.js";
import { CLI_HELP } from "./cli-help-text.js";
import { tryExecuteDeploymentCommand } from "./cli-deployment-commands.js";
import { tryExecutePortfolioCollectCommand } from "./cli-portfolio-collect.js";
import { tryExecuteWorkboardReplyGap } from "./cli-workboard-reply-gap.js";
import { CLI_OPTIONS } from "./cli-option-table.js";
import { executeCompanyCandidates } from "./cli-company-candidates.js";

const COMMAND_HANDLERS: readonly CliCommandHandler[] = [
  executeCompanyCandidates,
  executeLocalTimeline,
  executeCoreCommand,
  executeControlCommand,
  executeLiveCommand,
  executeGjcCommand,
  executeDailyCommand,
  executePreGjcCommand,
  executeStateCommand,
];

export async function execute(args: string[], dependencies: CliDependencies = {}): Promise<Record<string, unknown>> {
  dependencies = { ...dependencies,
    memoryReferenceOptions: dependencies.memoryReferenceOptions ?? hostMemoryReferenceOptions(),
    memoryWithdrawalOptions: dependencies.memoryWithdrawalOptions ?? hostMemoryWithdrawalOptions() };
  if (requestsHelp(args)) {
    console.log(CLI_HELP);
    return { ok: true, command: "help" };
  }
  const parsed = (() => {
    try {
      return parseArgs({
        args,
        options: CLI_OPTIONS,
        allowPositionals: true,
        strict: true,
      });
    } catch {
      throw new JarvisError("CLI_ARGUMENT_INVALID");
    }
  })();
  const [command, subcommand, argument, fourth, fifth, sixth] = parsed.positionals;
  const values = normalizeCliValues(parsed.values);
  if ((values["company-config"] !== undefined || values["company-completion-config"] !== undefined)
    && command !== "company-candidates") throw new JarvisError("COMPANY_CALLER_CONFIG_INVALID");
  if (values["company-freshness-config"] !== undefined && command !== "company-candidates"
    && !(command === "control" && subcommand === "decide")) throw new JarvisError("COMPANY_CALLER_CONFIG_INVALID");
  // Reported and rendered before anything opens a database: these are the paths a database would
  // be opened at, so they have to be answerable when that open would fail.
  const deployment = tryExecuteDeploymentCommand({ positionals: parsed.positionals, values: parsed.values });
  if (deployment !== undefined) return deployment;
  // Collection reads the local host and writes a signed spool file. It opens no database, and it
  // is answered here so it cannot: the collector runs as the interactive user whose GUI session it
  // reads, while the authority database belongs to the service account (cutover gap G4).
  const collected = await tryExecutePortfolioCollectCommand({
    positionals: parsed.positionals, values: parsed.values });
  if (collected !== undefined) return collected;
  // The collector's own flags belong to the portfolio commands and to nothing else.
  const collectorFlags: readonly (keyof typeof parsed.values)[] =
    ["spool", "orca-bin", "gh-bin", "git-bin", "scope-file", "status-file"];
  if (collectorFlags.some(key => parsed.values[key] !== undefined) && command !== "portfolio") {
    throw new JarvisError("PORTFOLIO_SPOOL_INPUT_INVALID");
  }
  const localTimeline = localTimelinePreflight(parsed.positionals, values);
  const gateCommand = await executeReleaseGateCommand(parsed.positionals, values, dependencies);
  if (gateCommand !== undefined) return gateCommand;
  const readinessCommand = await tryExecuteSecondBrainReadinessCommand({ positionals: parsed.positionals,
    values: parsed.values, clock: dependencies.clock, secondBrainProbe: dependencies.secondBrainProbe });
  if (readinessCommand !== undefined) return readinessCommand;
  // The receipt path is an input to the readiness probe and to nothing else.
  if (values["refresh-receipt"] !== undefined) throw new JarvisError("SECOND_BRAIN_READINESS_INPUT_INVALID");
  // A rehearsal never migrates the database it was pointed at, so it cannot be a modifier on any
  // other command: the only accepted form returned above.
  if (values.rehearse !== undefined) throw new JarvisError("MIGRATION_REHEARSAL_INPUT_INVALID");
  if (values["local-timeline-refresh"] !== undefined
    && (command !== "service" || !["once", "run"].includes(subcommand ?? "") || !values.db)) {
    throw new JarvisError("LOCAL_COLLECTION_CONFIG_INVALID");
  }
  if ((values["memory-review-cleanup-root"] !== undefined || values["memory-review-cleanup-limit"] !== undefined)
    && (command !== "service" || !["once", "run"].includes(subcommand ?? ""))) {
    throw new JarvisError("MEMORY_REVIEW_CLEANUP_CONFIG_INVALID");
  }
  if (values["remote-audit-retention-limit"] !== undefined
    && (command !== "service" || !["once", "run"].includes(subcommand ?? ""))) {
    throw new JarvisError("REMOTE_AUDIT_RETENTION_CONFIG_INVALID");
  }
  if (command === "routing") {
    if (Object.keys(parsed.values).some(key => key !== "json")) throw new JarvisError("WORK_ROUTING_INPUT_INVALID");
    if (subcommand === "templates" && parsed.positionals.length === 2) {
      return { ok: true, command: "routing.templates", templates: taskTemplateCatalog() };
    }
    if (subcommand === "compile-template" && parsed.positionals.length === 3 && argument) {
      return executeTaskTemplateCompilation(argument);
    }
    if (subcommand === "executors" && parsed.positionals.length === 2) {
      return { ok: true, command: "routing.executors", executors: inspectTaskExecutors() };
    }
    if (subcommand === "executor" && parsed.positionals.length === 3 && argument) {
      return { ok: true, command: "routing.executor", executor: inspectTaskExecutor(argument) };
    }
    if (subcommand === "probe-runtime" && parsed.positionals.length === 3 && argument) {
      return { ok: true, command: "routing.probe-runtime", executor: await probeTaskExecutorRuntime(argument) };
    }
    if (subcommand === "probe-executor" && parsed.positionals.length === 3 && argument) {
      return { ok: true, command: "routing.probe-executor", executor: await probeTaskExecutor(argument) };
    }
    if (subcommand === "validate-plan" && parsed.positionals.length === 4 && argument && fourth) {
      return executeExecutorPlanValidation(argument, fourth);
    }
    if (subcommand !== "classify" || parsed.positionals.length !== 4 || !argument || !fourth) {
      throw new JarvisError("WORK_ROUTING_INPUT_INVALID");
    }
    return executeWorkRouting(argument, fourth);
  }
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    console.log(CLI_HELP);
    return { ok: true, command: "help" };
  }
  if (command === "runtime" && subcommand === "identity") {
    if (parsed.positionals.length !== 2 || Object.keys(parsed.values).some(key => key !== "db" && key !== "json")) {
      throw new JarvisError("UNKNOWN_COMMAND");
    }
    return inspectRuntimeIdentity(values.db, dependencies.clock?.() ?? new Date());
  }
  if (command === "daily" && (!["morning", "evening"].includes(subcommand ?? "") || parsed.positionals.length !== 2
    || values.once !== true || !values.db || !values.input
    || (subcommand === "evening" && !values["key-file"])
    || Object.keys(parsed.values).some(key => !["db", "input", "once", "json",
      ...(subcommand === "evening" ? ["key-file"] : [])].includes(key)))) {
    throw new JarvisError("DAILY_LOOP_CONFIG_INVALID");
  }
  const auditHistory = command === "report" && subcommand === "remote-audit";
  if (auditHistory) {
    if (parsed.positionals.length !== 3 || !argument || !values.db
      || Object.keys(parsed.values).some(key => !["db", "json"].includes(key))) {
      throw new JarvisError("REMOTE_AUDIT_HISTORY_INPUT_INVALID");
    }
    try { if (!statSync(values.db).isFile()) throw new Error(); }
    catch { throw new JarvisError("REMOTE_AUDIT_HISTORY_DATABASE_UNAVAILABLE"); }
  }
  const performanceReport = command === "report" && subcommand === "task-performance";
  const routingShadow = command === "report" && subcommand === "routing-shadow";
  const performanceAt = performanceReport || routingShadow ? dependencies.clock?.() ?? new Date() : undefined;
  let shadowPolicies: unknown[] = [];
  if (performanceReport || routingShadow) {
    if (parsed.positionals.length !== (routingShadow ? 6 : 4) || !values.db
      || Object.keys(parsed.values).some(key => !["db", "json"].includes(key))) {
      throw new JarvisError("TASK_PERFORMANCE_INPUT_INVALID");
    }
    taskPerformanceWindow(argument, fourth, performanceAt!);
    if (routingShadow) shadowPolicies = [await readWorkRoutingPolicy(fifth!), await readWorkRoutingPolicy(sixth!)];
    try { if (!statSync(values.db).isFile()) throw new Error(); }
    catch { throw new JarvisError("TASK_PERFORMANCE_DATABASE_UNAVAILABLE"); }
  }
  const readOnlyReport = auditHistory || performanceReport || routingShadow
    || (localTimeline && ["snapshot", "subjects"].includes(subcommand ?? ""));
  const dbOptions = readOnlyReport ? { fileMustExist: true, readonly: true }
    : localTimeline ? { fileMustExist: true } : undefined;
  const db = new AuthorityDb(values.db, undefined, dbOptions);
  const context: CliCommandContext = {
    args,
    values,
    positionals: parsed.positionals,
    command,
    subcommand,
    argument,
    fourth,
    fifth,
    sixth,
    db,
    dependencies,
  };
  try {
    const bootstrap = await executeBootstrapCommand(context);
    if (bootstrap !== undefined) return bootstrap;
    await db.assertMigrationsReady();
    const replyGap = await tryExecuteWorkboardReplyGap(context);
    if (replyGap !== undefined) return replyGap;
    if (auditHistory) return { ok: true, command: "report.remote-audit", history: readRemoteAuditHistory(db.db, argument!) };
    if (routingShadow) return { ok: true, command: "report.routing-shadow",
      report: readTaskRoutingShadow(db, argument, fourth, shadowPolicies[0], shadowPolicies[1], performanceAt) };
    if (performanceReport) return { ok: true, command: "report.task-performance",
      report: readTaskPerformance(db, argument, fourth, performanceAt) };
    for (const handler of COMMAND_HANDLERS) {
      const result = await handler(context);
      if (result !== undefined) return result;
    }
    throw new JarvisError("UNKNOWN_COMMAND");
  } finally {
    db.close();
  }
}

function requestsHelp(args: readonly string[]): boolean {
  const first = args[0];
  return first === "--help" || first === "-h" || first === "help"
    || args.includes("--help") || args.includes("-h") || args.includes("help");
}
