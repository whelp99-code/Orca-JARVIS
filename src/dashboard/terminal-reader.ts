import { JarvisError } from "../db.js";
import { OrcaReadonlyAdapter, type OrcaRunner, type OrcaTerminal } from "../orca.js";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";
import type { DashboardReadModel, OverviewAgent } from "./read-model.js";
import { redactDashboardValue, redactTerminalLine } from "./redaction.js";

export type TerminalLogResponse = {
  readonly schema_version: 1;
  readonly agent_id: string;
  readonly status: string;
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly next_cursor: string | null;
};

export type TerminalLogResult =
  | { readonly kind: "ok"; readonly value: TerminalLogResponse }
  | { readonly kind: "not_found" }
  | { readonly kind: "orca_unavailable" };

export class DashboardTerminalReader {
  private readonly adapter: OrcaReadonlyAdapter;

  constructor(
    private readonly model: DashboardReadModel,
    runner?: OrcaRunner,
  ) {
    this.adapter = new OrcaReadonlyAdapter(runner);
  }

  async read(agentId: string, limit: number): Promise<TerminalLogResult> {
    const lookup = this.model.agentDetail(agentId);
    switch (lookup.kind) {
      case "not_found":
        return { kind: "not_found" };
      case "found":
        return this.readExactBinding(lookup.value.agent, limit);
      default:
        return assertNever(lookup);
    }
  }

  private async readExactBinding(agent: OverviewAgent, limit: number): Promise<TerminalLogResult> {
    try {
      const terminals = await this.adapter.list(agent.canonical_path);
      const match = exactLiveTerminal(terminals, agent);
      if (match === undefined) return { kind: "not_found" };
      const result = await this.adapter.read(match.handle, null, limit);
      return {
        kind: "ok",
        value: redactDashboardValue({
          schema_version: DASHBOARD_SCHEMA_VERSION,
          agent_id: agent.agent_id,
          status: result.status,
          lines: result.tail.slice(0, limit).map(redactTerminalLine),
          truncated: result.truncated,
          next_cursor: result.nextCursor,
        }),
      };
    } catch (error) {
      if (error instanceof JarvisError) return { kind: "orca_unavailable" };
      throw error;
    }
  }
}

function exactLiveTerminal(
  terminals: readonly OrcaTerminal[],
  agent: OverviewAgent,
): OrcaTerminal | undefined {
  const matches = terminals.filter((terminal) =>
    terminal.handle === agent.terminal_id && terminal.incarnationId === agent.incarnation_id
  );
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  return match;
}

function assertNever(value: never): never {
  throw new Error(`unexpected terminal lookup: ${JSON.stringify(value)}`);
}
