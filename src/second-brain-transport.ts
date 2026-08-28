import { execFile as nodeExecFile, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";

export const SECOND_BRAIN_LAUNCHER = "/home/jm/.local/state/second-brain/app/current/bin/second-brain-mcp";
export const SECOND_BRAIN_CONFIG = "/home/jm/.config/second-brain/config.toml";
export const SECOND_BRAIN_PROTOCOL_VERSION = "2026-07-28";
export const SECOND_BRAIN_FRAME_BYTES = 1_048_576;
export const SECOND_BRAIN_DEADLINES = { startup: 5_000, read: 10_000, write: 30_000 } as const;
const READ_METHODS = ["sb_search", "sb_read_page", "sb_recent_changes", "sb_open_conflicts"] as const;
const WRITE_METHOD = "sb_remember" as const;
const TOOL_SCHEMAS = {
  sb_open_conflicts: { additionalProperties: false, properties: {}, required: [], type: "object" },
  sb_read_page: { additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"], type: "object" },
  sb_recent_changes: { additionalProperties: false, properties: { days: { default: 7, type: "integer" } }, required: [], type: "object" },
  sb_remember: { additionalProperties: false, properties: { content: { type: "string" }, title: { default: null, type: ["string", "null"] } }, required: ["content"], type: "object" },
  sb_search: { additionalProperties: false, properties: { limit: { default: 10, type: "integer" }, query: { type: "string" } }, required: ["query"], type: "object" },
} as const;

export type SecondBrainReadMethod = (typeof READ_METHODS)[number];
export type SecondBrainMethod = SecondBrainReadMethod | typeof WRITE_METHOD;
export type SecondBrainDisposition = "unavailable" | "cancelled" | "uncertain" | "fatal";
export type SecondBrainOutcome = { readonly kind: "data"; readonly value: Readonly<Record<string, unknown>> } | { readonly kind: "no_data"; readonly reason: "empty_result" } | { readonly kind: "error"; readonly code: string };
export type SecondBrainDiagnostic = { readonly code: string; readonly generation: number; readonly method?: SecondBrainMethod; readonly request_id?: string; readonly duration_ms?: number; readonly pending_count?: number; readonly queued_count?: number; readonly stderr_bytes?: number; readonly listener_count?: number; readonly timer_count?: number };
export type SecondBrainTimerHandle = ReturnType<typeof setTimeout> | number;
export type SecondBrainTimers = { readonly set: (callback: () => void, delay: number) => SecondBrainTimerHandle; readonly clear: (handle: SecondBrainTimerHandle) => void };
export type SecondBrainExecFileOptions = { readonly shell: false; readonly env: Readonly<Record<string, string>>; readonly windowsHide: true };
export type SecondBrainExecFile = (file: string, args: readonly string[], options: SecondBrainExecFileOptions) => ChildProcess;
export type SecondBrainTransportOptions = {
  readonly launcherPath?: string;
  readonly configPath?: string;
  readonly execFile?: SecondBrainExecFile;
  readonly realpath?: (path: string) => string;
  readonly timers?: SecondBrainTimers;
  readonly clock?: () => number;
  readonly deadlines?: Readonly<typeof SECOND_BRAIN_DEADLINES>;
  readonly safeReadRetries?: 0 | 1;
  readonly onDiagnostic?: (diagnostic: SecondBrainDiagnostic) => void;
};
export type SecondBrainCallOptions = { readonly signal?: AbortSignal };
export interface SecondBrainTransport {
  call(method: SecondBrainMethod, arguments_: Readonly<Record<string, unknown>>, options?: SecondBrainCallOptions): Promise<SecondBrainOutcome>;
  restart(): Promise<void>;
  close(): Promise<void>;
  diagnostics(): readonly SecondBrainDiagnostic[];
}

export class SecondBrainTransportError extends Error {
  readonly name = "SecondBrainTransportError";
  constructor(readonly code: string, readonly disposition: SecondBrainDisposition, readonly generation: number, readonly request_id?: string) { super(code); }
}

type Pending = { readonly id: string; readonly method?: SecondBrainMethod; readonly write: boolean; readonly started: number; readonly resolve: (value: Record<string, unknown>) => void; readonly reject: (error: SecondBrainTransportError) => void; readonly timer: SecondBrainTimerHandle; readonly signal?: AbortSignal; abort?: () => void };
type QueueItem = { readonly method: SecondBrainMethod; readonly arguments_: Readonly<Record<string, unknown>>; readonly options: SecondBrainCallOptions; readonly resolve: (value: SecondBrainOutcome) => void; readonly reject: (error: SecondBrainTransportError) => void; abort?: () => void };

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new SecondBrainTransportError("SECOND_BRAIN_MALFORMED_FRAME", "fatal", 0);
  return value;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const item = record(value); return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
}
function isRead(method: SecondBrainMethod): method is SecondBrainReadMethod { return method !== WRITE_METHOD; }
function outcome(value: Record<string, unknown>): SecondBrainOutcome {
  if (value.isError === true) return { kind: "error", code: "SECOND_BRAIN_TOOL_ERROR" };
  const content = value.content; if (!Array.isArray(content) || content.length !== 1) throw new SecondBrainTransportError("SECOND_BRAIN_SCHEMA_MISMATCH", "fatal", 0);
  const entry = record(content[0]); if (entry.type !== "text" || typeof entry.text !== "string") throw new SecondBrainTransportError("SECOND_BRAIN_SCHEMA_MISMATCH", "fatal", 0);
  let parsed: Record<string, unknown>; try { parsed = record(JSON.parse(entry.text)); } catch (error) { if (error instanceof SecondBrainTransportError) throw error; throw new SecondBrainTransportError("SECOND_BRAIN_SCHEMA_MISMATCH", "fatal", 0); }
  const lists = [parsed.results, parsed.changes, parsed.conflicts]; if (lists.some(item => Array.isArray(item) && item.length === 0)) return { kind: "no_data", reason: "empty_result" };
  return { kind: "data", value: parsed };
}

class SupervisedSecondBrainTransport implements SecondBrainTransport {
  // Mutable fields are the transport generation, request registry, and bounded schedulers they supervise.
  private child: ChildProcess | undefined; private generation = 0; private sequence = 0; private buffer = Buffer.alloc(0); private stderrBuffer = ""; private stderrBytes = 0; private starting: Promise<void> | undefined; private closed = false; private failed = false;
  private readonly pending = new Map<string, Pending>(); private readonly seen = new Set<string>(); private readonly retired = new Set<string>(); private readonly events: SecondBrainDiagnostic[] = []; private readonly readQueue: QueueItem[] = []; private readonly writeQueue: QueueItem[] = []; private activeReads = 0; private activeWrites = 0;
  private readonly launcher: string; private readonly config: string; private readonly run: SecondBrainExecFile; private readonly resolvePath: (path: string) => string; private readonly timers: SecondBrainTimers; private readonly now: () => number; private readonly deadlines: Readonly<typeof SECOND_BRAIN_DEADLINES>; private readonly retries: 0 | 1; private readonly report?: (diagnostic: SecondBrainDiagnostic) => void;
  constructor(options: SecondBrainTransportOptions) {
    this.launcher = options.launcherPath ?? SECOND_BRAIN_LAUNCHER; this.config = options.configPath ?? SECOND_BRAIN_CONFIG;
    this.run = options.execFile ?? ((file, args, childOptions) => nodeExecFile(file, [...args], childOptions)); this.resolvePath = options.realpath ?? realpathSync;
    this.timers = options.timers ?? { set: (callback, delay) => setTimeout(callback, delay), clear: handle => clearTimeout(handle) }; this.now = options.clock ?? Date.now; this.deadlines = options.deadlines ?? SECOND_BRAIN_DEADLINES; this.retries = options.safeReadRetries ?? 1; this.report = options.onDiagnostic;
  }
  diagnostics(): readonly SecondBrainDiagnostic[] { return this.events.map(item => ({ ...item })); }
  call(method: SecondBrainMethod, arguments_: Readonly<Record<string, unknown>>, options: SecondBrainCallOptions = {}): Promise<SecondBrainOutcome> {
    if (![...READ_METHODS, WRITE_METHOD].includes(method)) return Promise.reject(this.error("SECOND_BRAIN_METHOD_DENIED", "fatal"));
    return new Promise((resolve, reject) => { const item: QueueItem = { method, arguments_, options, resolve, reject }; const queue = isRead(method) ? this.readQueue : this.writeQueue; if (options.signal?.aborted) { reject(this.error("SECOND_BRAIN_CANCELLED", "cancelled")); return; } if (options.signal) { item.abort = () => { const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1); reject(this.error("SECOND_BRAIN_CANCELLED", "cancelled")); this.pump(); }; options.signal.addEventListener("abort", item.abort, { once: true }); } queue.push(item); this.pump(); });
  }
  private pump(): void {
    while (!this.closed && this.activeReads < 4 && this.readQueue.length > 0) { const item = this.readQueue.shift(); if (!item) break; this.activeReads += 1; this.dispatch(item).finally(() => { this.activeReads -= 1; this.pump(); }); }
    if (!this.closed && this.activeWrites === 0) { const item = this.writeQueue.shift(); if (item) { this.activeWrites = 1; this.dispatch(item).finally(() => { this.activeWrites = 0; this.pump(); }); } }
  }
  private async dispatch(item: QueueItem): Promise<void> {
    if (item.abort && item.options.signal) item.options.signal.removeEventListener("abort", item.abort); let attempt = 0;
    for (;;) { try { await this.ensureStarted(); const raw = await this.request(item.method, item.arguments_, item.options.signal, isRead(item.method) ? this.deadlines.read : this.deadlines.write); item.resolve(outcome(raw)); return; } catch (caught) { const error = caught instanceof SecondBrainTransportError ? caught : this.error("SECOND_BRAIN_START_FAILED", "unavailable"); if (isRead(item.method) && error.code === "SECOND_BRAIN_CHILD_EXIT" && attempt < this.retries) { attempt += 1; continue; } item.reject(error); return; } }
  }
  private async ensureStarted(): Promise<void> { if (this.child && !this.failed) return; if (!this.starting) this.starting = this.start().finally(() => { this.starting = undefined; }); return this.starting; }
  private async start(): Promise<void> {
    if (this.closed) throw this.error("SECOND_BRAIN_CLOSED", "unavailable"); let target: string; try { target = this.resolvePath(this.launcher); } catch { throw this.error("SECOND_BRAIN_DISCOVERY_FAILED", "unavailable"); }
    this.generation += 1; this.sequence = 0; this.buffer = Buffer.alloc(0); this.stderrBuffer = ""; this.stderrBytes = 0; this.failed = false; this.seen.clear(); this.retired.clear();
    const child = this.run(target, [], { shell: false, env: { SB_CONFIG: this.config }, windowsHide: true }); this.child = child;
    child.stdout?.on("data", this.onData); child.stderr?.on("data", this.onStderr); child.once("error", this.onStartError); child.once("close", this.onClose);
    const initialize = await this.request(undefined, { protocolVersion: SECOND_BRAIN_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "orca-jarvis", version: "1" } }, undefined, this.deadlines.startup, "initialize");
    const server = record(initialize.serverInfo); if (initialize.protocolVersion !== SECOND_BRAIN_PROTOCOL_VERSION || server.name !== "second-brain" || typeof server.version !== "string") { const error = this.error("SECOND_BRAIN_VERSION_MISMATCH", "fatal"); this.fail(error); throw error; }
    this.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const listed = await this.request(undefined, {}, undefined, this.deadlines.startup, "tools/list"); const tools = listed.tools; if (!Array.isArray(tools) || tools.length !== 5) { const error = this.error("SECOND_BRAIN_SCHEMA_MISMATCH", "fatal"); this.fail(error); throw error; }
    const observed = new Map<string, unknown>(); for (const raw of tools) { const tool = record(raw); if (typeof tool.name !== "string") throw this.error("SECOND_BRAIN_SCHEMA_MISMATCH", "fatal"); observed.set(tool.name, tool.inputSchema); }
    for (const [name, schema] of Object.entries(TOOL_SCHEMAS)) if (canonical(observed.get(name)) !== canonical(schema)) { const error = this.error("SECOND_BRAIN_SCHEMA_MISMATCH", "fatal"); this.fail(error); throw error; }
    this.emit({ code: "SECOND_BRAIN_STARTED", generation: this.generation, pending_count: this.pending.size });
  }
  private request(method: SecondBrainMethod | undefined, arguments_: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, timeout: number, protocolMethod = "tools/call"): Promise<Record<string, unknown>> {
    const id = `${this.generation}:${++this.sequence}`; return new Promise((resolve, reject) => {
      const timer = this.timers.set(() => { const pending = this.pending.get(id); if (!pending) return; this.pending.delete(id); this.detach(pending); const write = method === WRITE_METHOD; reject(this.error(write ? "SECOND_BRAIN_WRITE_TIMEOUT" : method ? "SECOND_BRAIN_READ_TIMEOUT" : "SECOND_BRAIN_STARTUP_TIMEOUT", write ? "uncertain" : "unavailable", id)); }, timeout);
      const pending: Pending = { id, method, write: method === WRITE_METHOD, started: this.now(), resolve, reject, timer, signal }; if (signal) { pending.abort = () => { if (!this.pending.delete(id)) return; this.detach(pending); this.retired.add(id); this.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } }); reject(this.error("SECOND_BRAIN_CANCELLED", "cancelled", id)); }; signal.addEventListener("abort", pending.abort, { once: true }); }
      this.pending.set(id, pending); const params = protocolMethod === "tools/call" ? { name: method, arguments: arguments_ } : arguments_; if (method) this.emit({ code: "SECOND_BRAIN_REQUESTED", generation: this.generation, method, request_id: id, pending_count: this.pending.size }); this.send({ jsonrpc: "2.0", id, method: protocolMethod, params });
    });
  }
  private send(message: Readonly<Record<string, unknown>>): void { if (!this.child?.stdin?.writable) throw this.error("SECOND_BRAIN_CHILD_EXIT", "unavailable"); this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer = Buffer.concat([this.buffer, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]); if (this.buffer.byteLength > SECOND_BRAIN_FRAME_BYTES) { this.fail(this.error("SECOND_BRAIN_OVERSIZE_FRAME", "fatal")); return; }
    for (;;) { const newline = this.buffer.indexOf(10); if (newline < 0) return; const frame = this.buffer.subarray(0, newline); this.buffer = this.buffer.subarray(newline + 1); if (frame.byteLength > SECOND_BRAIN_FRAME_BYTES) { this.fail(this.error("SECOND_BRAIN_OVERSIZE_FRAME", "fatal")); return; } this.frame(frame); }
  };
  private frame(frame: Buffer): void {
    let message: Record<string, unknown>; try { message = record(JSON.parse(frame.toString("utf8"))); } catch { this.fail(this.error("SECOND_BRAIN_MALFORMED_FRAME", "fatal")); return; }
    const id = message.id; if (message.jsonrpc !== "2.0" || typeof id !== "string") { this.fail(this.error("SECOND_BRAIN_MALFORMED_FRAME", "fatal")); return; }
    if (this.retired.delete(id)) return; const pending = this.pending.get(id); if (!pending) { this.fail(this.error(this.seen.has(id) ? "SECOND_BRAIN_DUPLICATE_FRAME" : "SECOND_BRAIN_UNMATCHED_FRAME", "fatal", id)); return; }
    this.pending.delete(id); this.seen.add(id); this.detach(pending); if (message.error !== undefined) pending.reject(this.error("SECOND_BRAIN_PROTOCOL_ERROR", pending.write ? "uncertain" : "unavailable", id)); else { try { pending.resolve(record(message.result)); } catch { pending.reject(this.error("SECOND_BRAIN_MALFORMED_FRAME", "fatal", id)); } }
  }
  private readonly onStderr = (chunk: Buffer | string): void => { const text = typeof chunk === "string" ? chunk : chunk.toString("utf8"); this.stderrBytes = Math.min(65_536, this.stderrBytes + Buffer.byteLength(text)); this.stderrBuffer += text; for (;;) { const newline = this.stderrBuffer.indexOf("\n"); if (newline < 0) return; this.stderrBuffer = this.stderrBuffer.slice(newline + 1); this.emit({ code: "SECOND_BRAIN_STDERR", generation: this.generation, stderr_bytes: this.stderrBytes }); } };
  private readonly onStartError = (): void => { this.fail(this.error("SECOND_BRAIN_START_FAILED", "unavailable")); };
  private readonly onClose = (): void => { if (this.closed || this.failed) return; this.failed = true; const error = this.error("SECOND_BRAIN_CHILD_EXIT", "unavailable"); this.settleGeneration(error); this.emit({ code: error.code, generation: this.generation, pending_count: 0, stderr_bytes: this.stderrBytes }); this.child = undefined; };
  private detach(pending: Pending): void { this.timers.clear(pending.timer); if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort); }
  private settleGeneration(error: SecondBrainTransportError): void { for (const pending of [...this.pending.values()]) { this.pending.delete(pending.id); this.detach(pending); pending.reject(pending.write ? this.error("SECOND_BRAIN_WRITE_INTERRUPTED", "uncertain", pending.id) : error); } }
  private fail(error: SecondBrainTransportError): void { if (this.failed) return; this.failed = true; this.settleGeneration(error); this.emit({ code: error.code, generation: this.generation, request_id: error.request_id, pending_count: 0, stderr_bytes: this.stderrBytes }); this.child?.kill(); this.child = undefined; }
  private async stop(child: ChildProcess | undefined): Promise<void> { if (!child) return; child.stdout?.off("data", this.onData); child.stderr?.off("data", this.onStderr); child.off("error", this.onStartError); child.off("close", this.onClose); if (child.exitCode !== null || child.signalCode !== null) return; await new Promise<void>(resolve => { child.once("close", () => resolve()); child.kill(); }); }
  private emit(event: SecondBrainDiagnostic): void { if (this.events.length === 256) this.events.shift(); this.events.push(event); this.report?.({ ...event }); }
  private error(code: string, disposition: SecondBrainDisposition, requestId?: string): SecondBrainTransportError { return new SecondBrainTransportError(code, disposition, this.generation, requestId); }
  async restart(): Promise<void> { const old = this.child; this.failed = true; this.settleGeneration(this.error("SECOND_BRAIN_CHILD_EXIT", "unavailable")); this.child = undefined; await this.stop(old); this.failed = false; await this.ensureStarted(); }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; this.settleGeneration(this.error("SECOND_BRAIN_CLOSED", "unavailable")); for (const item of [...this.readQueue, ...this.writeQueue]) { if (item.abort && item.options.signal) item.options.signal.removeEventListener("abort", item.abort); item.reject(this.error("SECOND_BRAIN_CLOSED", "unavailable")); } this.readQueue.length = 0; this.writeQueue.length = 0; const child = this.child; this.child = undefined; await this.stop(child); this.emit({ code: "SECOND_BRAIN_CLOSED", generation: this.generation, pending_count: 0, queued_count: 0, listener_count: 0, timer_count: 0 }); }
}

export function createSecondBrainTransport(options: SecondBrainTransportOptions = {}): SecondBrainTransport { return new SupervisedSecondBrainTransport(options); }
