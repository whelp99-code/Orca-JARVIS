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

const COMMAND_HANDLERS: readonly CliCommandHandler[] = [
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
        options: {
          db: { type: "string" },
          decision_public: { type: "string" },
          decision_key_id: { type: "string" },
          decision_principal: { type: "string" },
          verifier_public: { type: "string" },
          verifier_key_id: { type: "string" },
          verifier_principal: { type: "string" },
          json: { type: "boolean" },
          once: { type: "boolean" },
          crash: { type: "string" },
          worktree: { type: "string" },
          bindings: { type: "string" },
          limit: { type: "string" },
          cursor: { type: "string" },
          all: { type: "boolean" },
          max_pages: { type: "string" },
          max_bytes: { type: "string" },
          interval_ms: { type: "string" },
          "interval-ms": { type: "string" },
          environments: { type: "string" },
          live_resume: { type: "boolean" },
          session_id: { type: "string" },
          input: { type: "string" },
          idempotency_key: { type: "string" },
          allow_mutation: { type: "boolean" },
          worker: { type: "string" },
          source: { type: "string" },
          "key-file": { type: "string" },
          "memory-review-cleanup-root": { type: "string" },
          "memory-review-cleanup-limit": { type: "string" },
          "remote-audit-retention-limit": { type: "string" },
          "local-timeline-refresh": { type: "boolean" },
          "dashboard-url": { type: "string" },
          to: { type: "string" },
          "release-root": { type: "string" },
          "dry-run": { type: "boolean" },
          rehearse: { type: "string" },
          phase: { type: "string" },
          "rehearsal-receipt": { type: "string" },
          "production-root": { type: "boolean" },
          "restore-backup": { type: "string" },
          "refresh-receipt": { type: "string" },
          out: { type: "string" },
        },
        allowPositionals: true,
        strict: true,
      });
    } catch {
      throw new JarvisError("CLI_ARGUMENT_INVALID");
    }
  })();
  const [command, subcommand, argument, fourth, fifth, sixth] = parsed.positionals;
  const values = normalizeCliValues(parsed.values);
  // Reported and rendered before anything opens a database: these are the paths a database would
  // be opened at, so they have to be answerable when that open would fail.
  const deployment = tryExecuteDeploymentCommand({ positionals: parsed.positionals, values: parsed.values });
  if (deployment !== undefined) return deployment;
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
