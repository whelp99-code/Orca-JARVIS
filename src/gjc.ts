import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { JarvisError } from "./db.js";

export const GJC_PROTOCOL_VERSION = "2024-11-05";
export const GJC_ENV = {
  GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
  GJC_COORDINATOR_MCP_PROFILE: "jarvis",
  GJC_COORDINATOR_MCP_REPO: "Orca-JARVIS",
} as const;
export type GjcCall = {
  tool: string; arguments: Record<string, unknown>; mutation?: boolean; allow_mutation?: boolean; idempotency_key?: string;
};
export type GjcRun = {
  argv: readonly string[]; env: Record<string, string>; stdin: string; timeout_ms: number; max_output_bytes: number;
};
export type GjcRunResult = { stdout: string; stderr?: string; exitCode: number };
export type GjcRunner = (run: GjcRun) => Promise<GjcRunResult>;
const RUNNER_FAILURES = new Set(["GJC_MCP_TIMEOUT", "GJC_MCP_SPAWN_FAILED", "GJC_MCP_OUTPUT_LIMIT"]);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new JarvisError("GJC_MCP_MALFORMED");
  return value as Record<string, unknown>;
}

export async function spawnGjc(run: GjcRun): Promise<GjcRunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(run.argv[0]!, [...run.argv.slice(1)], {
      shell: false, env: { ...process.env, ...run.env }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr, exitCode: child.exitCode ?? -1 });
    };
    const take = (which: "stdout" | "stderr", chunk: Buffer) => {
      const next = (which === "stdout" ? stdout : stderr) + chunk.toString("utf8");
      if (Buffer.byteLength(next) > run.max_output_bytes) {
        child.kill();
        finish(new JarvisError("GJC_MCP_OUTPUT_LIMIT"));
        return;
      }
      if (which === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (chunk: Buffer) => take("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => take("stderr", chunk));
    child.on("error", () => finish(new JarvisError("GJC_MCP_SPAWN_FAILED")));
    child.on("close", code => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? -1 });
      }
    });
    const timer = setTimeout(() => { child.kill(); finish(new JarvisError("GJC_MCP_TIMEOUT")); }, run.timeout_ms);
    child.stdin.end(run.stdin);
  });
}

export class GjcCoordinatorClient {
  lastServerInfo: { name: string; version: string } | undefined;
  constructor(
    private readonly runner: GjcRunner = spawnGjc,
    private readonly mutationsEnabled = false,
    private readonly timeout_ms = 10_000,
    private readonly max_output_bytes = 64 * 1024,
  ) {}

  async call(cwd: string, call: GjcCall): Promise<Record<string, unknown>> {
    if (!call.tool || typeof call.tool !== "string") throw new JarvisError("GJC_TOOL_INVALID");
    if (call.mutation && (!this.mutationsEnabled || !call.allow_mutation || !call.idempotency_key)) {
      throw new JarvisError("GJC_MUTATION_DENIED");
    }
    let root: string;
    try { root = realpathSync(cwd); } catch { throw new JarvisError("GJC_CWD_INVALID"); }
    const initialize = {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: GJC_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "orca-jarvis", version: "1" } },
    };
    const initialized = { jsonrpc: "2.0", method: "notifications/initialized", params: {} };
    const arguments_ = call.mutation
      ? { ...call.arguments, allow_mutation: true, idempotency_key: call.idempotency_key }
      : call.arguments;
    const invoke = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: call.tool, arguments: arguments_ } };
    const env = {
      GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
      GJC_COORDINATOR_MCP_PROFILE: GJC_ENV.GJC_COORDINATOR_MCP_PROFILE,
      GJC_COORDINATOR_MCP_REPO: GJC_ENV.GJC_COORDINATOR_MCP_REPO,
      ...(call.mutation ? { GJC_COORDINATOR_MCP_MUTATIONS: GJC_ENV.GJC_COORDINATOR_MCP_MUTATIONS } : {}),
    };
    let result: GjcRunResult;
    try {
      result = await this.runner({
        argv: ["gjc", "mcp-serve", "coordinator"], env,
        stdin: `${JSON.stringify(initialize)}\n${JSON.stringify(initialized)}\n${JSON.stringify(invoke)}\n`,
        timeout_ms: this.timeout_ms, max_output_bytes: this.max_output_bytes,
      });
    } catch (error) {
      const code = error instanceof JarvisError && RUNNER_FAILURES.has(error.code) ? error.code : "GJC_MCP_RUNNER_FAILED";
      throw new JarvisError(code);
    }
    if (Buffer.byteLength(result.stdout) > this.max_output_bytes || Buffer.byteLength(result.stderr ?? "") > this.max_output_bytes) {
      throw new JarvisError("GJC_MCP_OUTPUT_LIMIT");
    }
    // External diagnostics can contain credentials without recognizable keys. Publish stable codes only.
    if (result.exitCode !== 0) throw new JarvisError("GJC_MCP_NONZERO");
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (lines.length !== 2) throw new JarvisError("GJC_MCP_MALFORMED");
    let init: Record<string, unknown>;
    let reply: Record<string, unknown>;
    try { init = object(JSON.parse(lines[0]!)); reply = object(JSON.parse(lines[1]!)); }
    catch { throw new JarvisError("GJC_MCP_MALFORMED"); }
    const initResult = object(init.result);
    const server = object(initResult.serverInfo);
    if (
      init.jsonrpc !== "2.0" || init.id !== 1 || initResult.protocolVersion !== GJC_PROTOCOL_VERSION
      || server.name !== "gjc-coordinator-mcp" || typeof server.version !== "string"
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(server.version) || reply.jsonrpc !== "2.0" || reply.id !== 2
    ) throw new JarvisError("GJC_MCP_PROTOCOL");
    this.lastServerInfo = { name: server.name, version: server.version };
    const response = object(reply.result);
    if (response.isError === true) throw new JarvisError("GJC_MCP_TOOL_ERROR");
    const content = response.content;
    if (!Array.isArray(content) || content.length !== 1) throw new JarvisError("GJC_MCP_MALFORMED");
    const text = object(content[0]);
    if (text.type !== "text" || typeof text.text !== "string") throw new JarvisError("GJC_MCP_MALFORMED");
    try {
      const parsed = object(JSON.parse(text.text));
      if (parsed.ok === false) throw new JarvisError("GJC_MCP_TOOL_ERROR");
      return parsed;
    } catch (error) {
      if (error instanceof JarvisError) throw error;
      throw new JarvisError("GJC_MCP_MALFORMED");
    }
  }
}
