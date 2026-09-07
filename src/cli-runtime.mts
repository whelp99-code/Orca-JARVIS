import { parseArgs } from "node:util";
import {
  type CliCommandContext,
  type CliCommandHandler,
  type CliDependencies,
  normalizeCliValues,
} from "./cli-command-context.js";
import { executeControlCommand } from "./cli-control-commands.js";
import { executeBootstrapCommand, executeCoreCommand } from "./cli-core-commands.js";
import { executeGjcCommand } from "./cli-gjc-commands.js";
import { executeLiveCommand } from "./cli-live-commands.js";
import { executePreGjcCommand } from "./cli-pre-gjc-commands.js";
import { executeStateCommand } from "./cli-state-commands.js";
import { AuthorityDb, JarvisError } from "./db.js";

const CLI_HELP =
  "JARVIS — agent-ops runtime\n"
  + "Commands: init, db migrate, doctor, project, supervisor, report, gjc, service, approval, census, work, control, timeline, runtime, "
  + "observe, pre-gjc, capabilities, team, portfolio, status\n"
  + "control plan-task <plan.json>: stage a task execution plan for separate approval (execution unavailable)";

const COMMAND_HANDLERS: readonly CliCommandHandler[] = [
  executeCoreCommand,
  executeControlCommand,
  executeLiveCommand,
  executeGjcCommand,
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
    },
    allowPositionals: true,
    strict: false,
  });
  const [command, subcommand, argument, fourth, fifth, sixth] = parsed.positionals;
  const values = normalizeCliValues(parsed.values);
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    console.log(CLI_HELP);
    return { ok: true, command: "help" };
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
