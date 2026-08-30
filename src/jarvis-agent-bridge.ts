import { TerminalWorkMemory } from "./terminal-work-memory.js";
import { TerminalMemoryError } from "./terminal-memory-validation.js";
import type { SqlSource } from "./terminal-work-memory.js";
import type { CheckpointInput, CloseoutInput, FailureInput, ResolutionInput } from "./terminal-memory-types.js";
export type BridgeRequest = Readonly<{ id?: string | number; method: string; params?: unknown }>;
export type BridgeResponse = Readonly<{ jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: string; message: string } }>;

const TOOL_NAMES = [
  "jarvis_current_context", "jarvis_terminal_context", "jarvis_checkpoint",
  "jarvis_record_failure", "jarvis_record_resolution", "jarvis_finish_work",
  "jarvis_project_activity", "jarvis_unresolved_failures", "jarvis_decision_queue",
] as const;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TerminalMemoryError("BRIDGE_PARAMS_INVALID");
  return value as Record<string, unknown>;
}
function id(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export class JarvisAgentBridge {
  constructor(private readonly memory: TerminalWorkMemory) {}

  tools(): readonly string[] { return TOOL_NAMES; }

  call(name: string, params: unknown): unknown {
    const input = record(params);
    switch (name) {
      case "jarvis_terminal_context": return this.memory.terminalContext(String(input.terminal_id), Number(input.limit ?? 50));
      case "jarvis_current_context": return this.memory.terminalContext(String(input.terminal_id), Number(input.limit ?? 50));
      case "jarvis_checkpoint": this.memory.checkpoint(input as unknown as CheckpointInput); return { accepted: true };
      case "jarvis_record_failure": this.memory.openFailure(input as unknown as FailureInput); return { accepted: true };
      case "jarvis_record_resolution": this.memory.resolveFailure(input as unknown as ResolutionInput); return { accepted: true };
      case "jarvis_finish_work": return this.memory.finishWork(input as unknown as CloseoutInput);
      case "jarvis_unresolved_failures": return this.memory.unresolvedFailures(Number(input.limit ?? 100));
      case "jarvis_project_activity": return this.memory.terminalContext(String(input.terminal_id), Number(input.limit ?? 50));
      case "jarvis_decision_queue": return { decisions: this.memory.decisionQueue(Number(input.limit ?? 100)), source: "authority" };
      default: throw new TerminalMemoryError("BRIDGE_TOOL_NOT_FOUND");
    }
  }

  handle(request: BridgeRequest): BridgeResponse {
    const requestId = id(request.id);
    try {
      if (request.method === "tools/list") return { jsonrpc: "2.0", id: requestId, result: { tools: TOOL_NAMES.map(name => ({ name })) } };
      if (request.method !== "tools/call") throw new TerminalMemoryError("BRIDGE_METHOD_NOT_FOUND");
      const params = record(request.params); const name = String(params.name);
      return { jsonrpc: "2.0", id: requestId, result: this.call(name, params.arguments ?? {}) };
    } catch (error) {
      const code = error instanceof TerminalMemoryError ? error.code : "BRIDGE_CALL_FAILED";
      return { jsonrpc: "2.0", id: requestId, error: { code, message: code } };
    }
  }

  handleLine(line: string): string {
    try { return JSON.stringify(this.handle(JSON.parse(line) as BridgeRequest)); }
    catch { return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: "BRIDGE_FRAME_INVALID", message: "BRIDGE_FRAME_INVALID" } }); }
  }
}

export function createJarvisAgentBridge(source: SqlSource): JarvisAgentBridge {
  return new JarvisAgentBridge(new TerminalWorkMemory(source));
}
