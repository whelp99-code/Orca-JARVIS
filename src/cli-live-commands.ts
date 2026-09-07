import { writeSync } from "node:fs";
import { ApprovedCommandExecutor } from "./approved-executor.js";
import { type CliCommandContext, commandNow } from "./cli-command-context.js";
import { integer, jsonFile, objectValue, providerValue } from "./cli-command-input.js";
import { JarvisError } from "./db.js";
import { isTransientOrcaReadFailure } from "./orca-read-envelope.js";
import { GjcCoordinatorClient } from "./gjc.js";
import { LiveSupervisor, type LiveBinding, type LiveObservation, type LiveSupervisorCycle } from "./live-supervisor.js";
import { AgentOpsMicroLoops, DurableMicroLoopRuntime } from "./microloops.js";
import {
  defaultRunner,
  discoverOrcaBindings,
  OrcaReadonlyAdapter,
  type OrcaRunner,
  type OrcaTerminal,
} from "./orca.js";
import { createOrcaRunner, decodeEnvWorktree, parseOrcaEnvironments } from "./orca-env.js";
import { OrcaTerminalResumeAdapter } from "./orca-resume.js";
import { PreGjcShadow } from "./pre-gjc-shadow.js";
import { GjcRuntimeService } from "./service.js";

function outputSync(value: object): void {
  writeSync(process.stdout.fd, `${JSON.stringify({ version: 1, ...value })}\n`);
}

export async function observeBound(binding: LiveBinding, runner?: OrcaRunner): Promise<readonly LiveObservation[]> {
  const decoded = decodeEnvWorktree(binding.canonical_path);
  const envRunner = createOrcaRunner(decoded.environment, runner ?? defaultRunner);
  const adapter = new OrcaReadonlyAdapter(envRunner);
  try {
    const terminals: OrcaTerminal[] = await adapter.list(decoded.listSelector);
    const terminal = terminals.find(item => item.handle === binding.terminal_id
      && item.incarnationId === binding.incarnation_id
      && item.ptyId === binding.pty_id
      && item.worktreeId === binding.worktree_id);
    if (!terminal) return [unknownObservation(binding)];
    if (!terminal.connected) return [{ ...unknownObservation(binding), connected: false }];
    const read = await adapter.read(binding.terminal_id, binding.cursor, 1);
    if (read.handle !== binding.terminal_id || !["ok", "running"].includes(read.status)) return [unknownObservation(binding)];
    return [{ ...unknownObservation(binding), cursor: read.nextCursor, connected: true }];
  } catch (error) {
    if (isTransientOrcaReadFailure(error)) {
      return [unknownObservation(binding)];
    }
    throw error;
  }
}

function unknownObservation(binding: LiveBinding): LiveObservation {
  return {
    provider: binding.provider,
    terminal_id: binding.terminal_id,
    session_id: binding.session_id,
    incarnation_id: binding.incarnation_id,
    cursor: binding.cursor,
    state: "unknown",
  };
}

export async function executeLiveCommand(
  context: CliCommandContext,
): Promise<Record<string, unknown> | undefined> {
  const { command, subcommand, argument, fourth, values, db, dependencies } = context;
  if (!isLiveCommand(command)) return undefined;
  const shadow = new PreGjcShadow(db);
  const supervisor = new LiveSupervisor(db);
  if (command === "project" && subcommand === "register" && argument) {
    const input = objectValue(await jsonFile(argument));
    const project = supervisor.register({
      worktree: String(input.worktree ?? ""),
      provider: providerValue(input.provider),
      terminal_id: String(input.terminal_id ?? ""),
      session_id: String(input.session_id ?? ""),
      incarnation_id: String(input.incarnation_id ?? ""),
      pty_id: typeof input.pty_id === "string" ? input.pty_id : undefined,
      worktree_id: typeof input.worktree_id === "string" ? input.worktree_id : undefined,
      project_id: typeof input.project_id === "string" ? input.project_id : undefined,
    });
    return { ok: true, command: "project.register", project };
  }
  if (command === "project" && subcommand === "discover") {
    const environments = parseOrcaEnvironments(values.environments);
    const discovered = await discoverOrcaBindings({
      runner: dependencies.orcaRunner,
      environments,
      tolerateRemoteFailure: true,
    });
    return {
      ok: true,
      command: "project.discover",
      environments,
      projects: discovered.map(binding => supervisor.register(binding)),
    };
  }
  if (command === "project" && subcommand === "list") {
    return { ok: true, command: "project.list", projects: supervisor.list() };
  }
  if (command === "project" && subcommand === "live-resume" && argument && fourth) {
    supervisor.configureLiveResume(argument, fourth === "enable", commandNow(context));
    return { ok: true, command: "project.live-resume", project_id: argument, enabled: fourth === "enable" };
  }
  const runSupervisor = async (): Promise<LiveSupervisorCycle> => {
    const now = commandNow(context);
    const result = await supervisor.cycleWithShadow(
      shadow,
      binding => observeBound(binding, dependencies.orcaRunner),
      now.toISOString(),
    );
    if (supervisor.liveResumeConfigured()) {
      const adapter = new OrcaTerminalResumeAdapter(db, true, dependencies.liveOrcaCommand, dependencies.clock);
      for (const intentId of supervisor.pendingLiveResumeIntents()) shadow.deliverResume(intentId, adapter, now);
      for (const intentId of shadow.pendingPolicyResumeIntents()) shadow.deliverPolicyResume(intentId, adapter, now);
    }
    return result;
  };
  if (command === "supervisor" && subcommand === "once") {
    return { ok: true, command: "supervisor.once", ...(await runSupervisor()) };
  }
  if (command === "supervisor" && subcommand === "watch") {
    const interval = values.interval_ms === undefined ? 10_000 : integer(values.interval_ms);
    if (interval < 1 || interval > 60_000) throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID");
    const cycle = async (): Promise<LiveSupervisorCycle> => {
      const result = await runSupervisor();
      deliverReport({ context, supervisor, command: "supervisor.watch", result, interval });
      return result;
    };
    const first = await cycle();
    if (values.once) return { ok: true, command: "supervisor.watch", interval_ms: interval, ...first };
    for (;;) {
      await new Promise<void>(resolve => setTimeout(resolve, interval));
      await cycle();
    }
  }
  if (command === "report" && subcommand === "ack" && argument) {
    supervisor.acknowledgeReport(argument);
    return { ok: true, command: "report.ack", report_id: argument };
  }
  if (command === "report" && subcommand === "status") {
    return { ok: true, command: "report.status", status: supervisor.status() };
  }
  if (command !== "runtime") return undefined;
  const runtime = new DurableMicroLoopRuntime(db);
  if (subcommand === "status") return { ok: true, command: "runtime.status", loops: runtime.status() };
  const gjc = new GjcCoordinatorClient(dependencies.gjcRunner, true);
  const service = new GjcRuntimeService(db, gjc, "gjc-dispatch-loop");
  const loops = new AgentOpsMicroLoops(db, new ApprovedCommandExecutor(db), service, async now => {
    return supervisor.cycleWithShadow(
      shadow,
      binding => observeBound(binding, dependencies.orcaRunner),
      now.toISOString(),
    );
  });
  try {
    if (subcommand === "once" && argument) {
      const handler = loops.handlers().find(item => item.name === argument);
      if (!handler) throw new JarvisError("MICROLOOP_UNKNOWN");
      return { ok: true, command: "runtime.once", outcome: await runtime.once(handler) };
    }
    if (subcommand === "batch") {
      return { ok: true, command: "runtime.batch", outcomes: await runtime.batch(loops.handlers()) };
    }
    return undefined;
  } finally {
    service.close();
  }
}

type ReportDelivery = {
  readonly context: CliCommandContext;
  readonly supervisor: LiveSupervisor;
  readonly command: string;
  readonly result: LiveSupervisorCycle;
  readonly interval: number;
};

function deliverReport(input: ReportDelivery): void {
  const report = input.result.recovered_report ?? input.result.report;
  if (!report) return;
  const output = input.context.dependencies.liveReportOutput ?? outputSync;
  output({ ok: true, command: input.command, interval_ms: input.interval, ...input.result });
  input.supervisor.acknowledgeReport(report.report_id);
}

function isLiveCommand(command: string | undefined): boolean {
  return command === "project" || command === "supervisor" || command === "report" || command === "runtime";
}
