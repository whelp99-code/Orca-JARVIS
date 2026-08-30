import type { CliCommandContext } from "./cli-command-context.js";
import { DailyControlRuntime } from "./daily-control-runtime.js";
import { SecondBrainProviderClient, MemorySettlementService } from "./second-brain-provider.js";
import { JarvisError } from "./db.js";

export async function executeRuntimeCommand(
  context: CliCommandContext,
): Promise<Record<string, unknown> | undefined> {
  if (context.command !== "runtime") return undefined;
  if (context.subcommand === "status") {
    return {
      ok: true,
      components: {
        agent_mcp: {
          executable: "scripts/jarvis-agent-mcp.mjs",
          configured: Boolean(process.env.JARVIS_DB),
        },
        daily_control: { executable: "scripts/jarvis-daily-control.mjs", configured: true },
        memory_settlement: {
          executable: "scripts/jarvis-memory-settlement.mjs",
          provider_bin_configured: Boolean(process.env.SECOND_BRAIN_PROVIDER_BIN),
        },
        shell_ingest: {
          executable: "scripts/collect-terminal-evidence.mjs",
          enabled: false,
        },
      },
    };
  }
  const runtime = new DailyControlRuntime({
    db: context.db,
    clock: context.dependencies.clock,
  });
  if (context.subcommand === "daily-control") {
    return { ok: true, ...(await runtime.once()) };
  }
  if (context.subcommand === "daily-status") {
    return { ok: true, ...runtime.status() };
  }
  if (context.subcommand === "memory-settlement" && context.argument) {
    const provider = new SecondBrainProviderClient({
      launcherPath: process.env.SECOND_BRAIN_PROVIDER_BIN,
      configPath: process.env.SECOND_BRAIN_PROVIDER_CONFIG,
    });
    try {
      const service = new MemorySettlementService({
        source: context.db.db,
        provider,
        owner: `cli:${process.pid}`,
      });
      return { ok: true, ...(await service.settle(context.argument)) };
    } finally {
      await provider.close();
    }
  }
  if (context.subcommand === "agent-mcp") {
    return {
      ok: true,
      executable: "scripts/jarvis-agent-mcp.mjs",
      configured: Boolean(process.env.JARVIS_DB),
    };
  }
  if (context.subcommand === "shell-ingest") {
    return {
      ok: true,
      executable: "scripts/collect-terminal-evidence.mjs",
      enabled: false,
      stdin_capture: false,
    };
  }
  throw new JarvisError("UNKNOWN_RUNTIME_COMMAND");
}
