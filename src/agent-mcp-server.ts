import { AuthorityDb } from "./db.js";
import { createJarvisAgentBridge, JarvisAgentBridge } from "./jarvis-agent-bridge.js";

export const JARVIS_MCP_PROTOCOL_VERSION = "2025-11-25" as const;
export const JARVIS_MCP_MAX_FRAME_BYTES = 1_048_576;

type Schema = Record<string, unknown>;
const boundedString: Schema = { type: "string", minLength: 1, maxLength: 512 };
const boundedLimit: Schema = { type: "integer", minimum: 1, maximum: 200, default: 50 };
const list = { type: "array", maxItems: 64, items: boundedString };
const nullableString: Schema = { ...boundedString, type: ["string", "null"] };
const objectSchema = (properties: Schema, required: readonly string[] = []): Schema => ({
  type: "object", additionalProperties: false, properties, required,
});

const toolSchemas: Readonly<Record<string, Schema>> = {
  jarvis_current_context: objectSchema({ terminal_id: boundedString, limit: boundedLimit }, ["terminal_id"]),
  jarvis_terminal_context: objectSchema({ terminal_id: boundedString, limit: boundedLimit }, ["terminal_id"]),
  jarvis_checkpoint: objectSchema({
    checkpoint_id: boundedString, correlation_id: boundedString, terminal_id: nullableString,
    work_id: nullableString, purpose: { ...boundedString, maxLength: 512 },
    decision: { ...boundedString, maxLength: 2048 }, failure_summary: nullableString,
    verification_summary: nullableString, next_step: nullableString, created_at: boundedString,
  }, ["checkpoint_id", "correlation_id", "purpose", "decision", "created_at"]),
  jarvis_record_failure: objectSchema({
    failure_id: boundedString, terminal_id: boundedString,
    terminal_incarnation_id: boundedString, source_event_id: boundedString,
    failure_class: boundedString, summary: { ...boundedString, maxLength: 1024 },
    severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] }, opened_at: boundedString,
  }, ["failure_id", "terminal_id", "terminal_incarnation_id", "source_event_id", "failure_class", "summary", "severity", "opened_at"]),
  jarvis_record_resolution: objectSchema({
    resolution_id: boundedString, failure_id: boundedString, source_event_ids: list,
    summary: { ...boundedString, maxLength: 1024 }, verification_id: boundedString,
    verified_at: boundedString, correlation_id: boundedString,
  }, ["resolution_id", "failure_id", "source_event_ids", "summary", "verification_id", "verified_at", "correlation_id"]),
  jarvis_finish_work: objectSchema({
    closeout_id: boundedString, work_id: boundedString, correlation_id: boundedString,
    terminal_ids: list, project_ids: list,
    outcome: { type: "string", enum: ["success", "partial", "failed", "cancelled", "blocked", "uncertain"] },
    verified_result: list, failed_items: list, unresolved_items: list, artifacts: list,
    commit_refs: list, issue_refs: list, improvements: list, next_actions: list,
    signed_at: boundedString,
  }, [
    "closeout_id", "work_id", "correlation_id", "terminal_ids", "project_ids", "outcome",
    "verified_result", "failed_items", "unresolved_items", "artifacts", "commit_refs",
    "issue_refs", "improvements", "next_actions", "signed_at",
  ]),
  jarvis_project_activity: objectSchema({ terminal_id: boundedString, limit: boundedLimit }, ["terminal_id"]),
  jarvis_unresolved_failures: objectSchema({ limit: boundedLimit }),
  jarvis_decision_queue: objectSchema({ limit: boundedLimit }),
};
const descriptions: Readonly<Record<string, string>> = {
  jarvis_current_context: "Read bounded current terminal context from the JARVIS authority database.",
  jarvis_terminal_context: "Read bounded terminal events and failures from JARVIS.",
  jarvis_checkpoint: "Persist a redacted terminal checkpoint.",
  jarvis_record_failure: "Record a terminal failure in the authority ledger.",
  jarvis_record_resolution: "Record a verified terminal failure resolution.",
  jarvis_finish_work: "Persist a verified terminal closeout.",
  jarvis_project_activity: "Read bounded project activity associated with a terminal.",
  jarvis_unresolved_failures: "List unresolved terminal failures.",
  jarvis_decision_queue: "List pending authority decisions.",
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function structured(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : { value };
}
function protocolError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const result: Record<string, unknown> = {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: structured(value),
    isError,
  };
  return result;
}

export function jarvisMcpTools(): readonly Record<string, unknown>[] {
  return Object.keys(toolSchemas).map((name) => ({
    name, description: descriptions[name], inputSchema: toolSchemas[name],
  }));
}

export function handleJarvisMcpRequest(
  bridge: JarvisAgentBridge,
  request: unknown,
): Record<string, unknown> | null {
  const input = record(request);
  const idValue = input.id;
  const id = typeof idValue === "string" || typeof idValue === "number" ? idValue : null;
  if (input.jsonrpc !== "2.0" || typeof input.method !== "string") {
    return protocolError(id, -32600, "Invalid Request");
  }
  if (input.method.startsWith("notifications/")) return null;
  if (input.method === "initialize") {
    return {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: JARVIS_MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "jarvis-agent-bridge", version: "1.0.0" },
      },
    };
  }
  if (input.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (input.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: jarvisMcpTools() } };
  }
  if (input.method !== "tools/call") return protocolError(id, -32601, "Method not found");
  const params = record(input.params);
  const name = typeof params.name === "string" ? params.name : "";
  if (!(name in toolSchemas)) {
    return { jsonrpc: "2.0", id, result: toolResult({ code: "BRIDGE_TOOL_NOT_FOUND" }, true) };
  }
  try {
    return { jsonrpc: "2.0", id, result: toolResult(bridge.call(name, params.arguments ?? {})) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "BRIDGE_CALL_FAILED";
    const code = /^[A-Z][A-Z0-9_]+$/u.test(message) ? message : "BRIDGE_CALL_FAILED";
    return { jsonrpc: "2.0", id, result: toolResult({ code }, true) };
  }
}

export type AgentMcpRuntime = Readonly<{ db: AuthorityDb; bridge: JarvisAgentBridge }>;
export async function openJarvisAgentMcp(dbPath = process.env.JARVIS_DB): Promise<AgentMcpRuntime> {
  if (!dbPath) throw new Error("JARVIS_DB_REQUIRED");
  const db = new AuthorityDb(dbPath);
  try {
    await db.migrate();
    await db.assertMigrationsReady();
    return { db, bridge: createJarvisAgentBridge(db.db) };
  } catch (error) {
    db.close();
    throw error;
  }
}

type AgentMcpOptions = Readonly<{
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  dbPath?: string;
}>;
export async function runJarvisAgentMcp(options: AgentMcpOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  let runtime: AgentMcpRuntime;
  try { runtime = await openJarvisAgentMcp(options.dbPath); }
  catch { errorOutput.write("jarvis-agent-mcp unavailable\n"); return; }
  let buffer = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  let oversize = false;
  let outputTail = Promise.resolve();
  const write = (value: Record<string, unknown>): void => {
    const line = `${JSON.stringify(value)}\n`;
    outputTail = outputTail.then(() => new Promise<void>((resolve, reject) => {
      output.write(line, (error?: Error | null) => error ? reject(error) : resolve());
    }));
  };
  const consume = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (oversize) {
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      oversize = false; buffer = bytes.subarray(newline + 1);
    } else buffer = Buffer.concat([buffer, bytes]);
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      let frame = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (frame.at(-1) === 13) frame = frame.subarray(0, frame.length - 1);
      if (frame.length > JARVIS_MCP_MAX_FRAME_BYTES) {
        write(protocolError(null, -32600, "Frame too large")); continue;
      }
      try {
        const response = handleJarvisMcpRequest(runtime.bridge, JSON.parse(frame.toString("utf8")));
        if (response) write(response);
      } catch { write(protocolError(null, -32700, "Parse error")); }
    }
    if (buffer.length > JARVIS_MCP_MAX_FRAME_BYTES) {
      oversize = true; buffer = Buffer.alloc(0);
      write(protocolError(null, -32600, "Frame too large"));
    }
  };
  input.on("data", consume);
  await new Promise<void>((resolve) => input.once("end", resolve));
  await outputTail;
  runtime.db.close();
}

if (process.argv[1]?.endsWith("agent-mcp-server.js")) {
  void runJarvisAgentMcp().catch(() => { process.exitCode = 1; });
}
