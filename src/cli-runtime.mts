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
import { inspectTaskExecutor, inspectTaskExecutors, probeTaskExecutor } from "./task-executor-registry.js";
import { executeLiveCommand } from "./cli-live-commands.js";
import { executePreGjcCommand } from "./cli-pre-gjc-commands.js";
import { executeStateCommand } from "./cli-state-commands.js";
import { AuthorityDb, JarvisError } from "./db.js";

const CLI_HELP =
  "JARVIS — agent-ops runtime\n"
  + "Commands: init, db migrate/rebuild-projections, doctor, project, supervisor, report, gjc, service, approval, census, work, control, timeline, runtime, "
  + "observe, pre-gjc, capabilities, team, portfolio, status, daily, routing\n"
  + "routing classify REQUEST.json POLICY.json: preview literal routing rules; no database or agent execution\n"
  + "routing executors | routing executor ID: inspect compiled registrations and configuration presence; no readiness probe\n"
  + "routing validate-plan ID PLAN.json: validate registered input structure; no approval, repository or readiness checks\n"
  + "routing probe-executor ID: query local CLI login status; no model call or execution authority\n"
  + "routing templates | routing compile-template INPUT.json: inspect or compile versioned task templates before approval\n"
  + "daily morning --once --db PATH --input CONFIG: run stored-source morning recovery; provider refresh unavailable\n"
  + "daily evening --once --db PATH --input CONFIG --key-file PATH: publish stored native completions; automatic operation held\n"
  + "service once/run --memory-review-cleanup-root PATH [--memory-review-cleanup-limit N]: clean eligible review files; existing private root, limit 1-1000\n"
  + "runtime identity [--db PATH]: observe this CLI build and persisted daemon identity without migrating the DB\n"
  + "report task-performance FROM TO --db PATH: current-state execution cohort metrics; no policy promotion\n"
  + "report routing-shadow FROM TO BASELINE.json CANDIDATE.json --db PATH: compare policies on historical task inputs; no execution\n"
  + "control plan-task <plan.json>: stage a task execution plan for separate approval (execution unavailable)\n"
  + "control check-task <plan.json>: check repository baseline and declared files without executing an agent\n"
  + "memory classify <input.json> <policy.json>: classify a bounded candidate; does not store memory\n"
  + "memory context <query> [--limit N] [--max_bytes N]: read bounded source-bound reference data; not a delivery receipt\n"
  + "memory reconcile-scoped <outbox-id> --once [--worker ID]: reconcile one spent request using host-authenticated scoped configuration\n"
  + "memory stage-dispatch <candidate-id>: stage an approved memory candidate for control approval\n"
  + "memory outbox --once [--limit N]: dispatch queued writes and reconcile their stored results\n"
  + "memory outbox list [--limit N]: inspect bounded memory delivery state";

const COMMAND_HANDLERS: readonly CliCommandHandler[] = [
  executeCoreCommand,
  executeControlCommand,
  executeLiveCommand,
  executeGjcCommand,
  executeDailyCommand,
  executePreGjcCommand,
  executeStateCommand,
];

export async function execute(
  args: string[],
  dependencies: CliDependencies = {},
): Promise<Record<string, unknown>> {
  if (requestsHelp(args)) {
    console.log(CLI_HELP);
    return { ok: true, command: "help" };
  }
  const parsed = parseArgs({
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
    },
    allowPositionals: true,
    strict: false,
  });
  const [command, subcommand, argument, fourth, fifth, sixth] = parsed.positionals;
  const values = normalizeCliValues(parsed.values);
  if ((values["memory-review-cleanup-root"] !== undefined || values["memory-review-cleanup-limit"] !== undefined)
    && (command !== "service" || !["once", "run"].includes(subcommand ?? ""))) {
    throw new JarvisError("MEMORY_REVIEW_CLEANUP_CONFIG_INVALID");
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
  const db = new AuthorityDb(values.db);
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
