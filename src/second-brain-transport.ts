import { execFile as nodeExecFile, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { frozenArgumentsMatch, inspectFrozenSchemas, snapshotArguments } from "./second-brain-frozen.js";
import { parseSecondBrainStrictJson } from "./second-brain-strict-json.js";
import {
	SECOND_BRAIN_CONFIG, SECOND_BRAIN_CONTRACT_PROFILE, SECOND_BRAIN_DEADLINES,
	SECOND_BRAIN_FRAME_BYTES, SECOND_BRAIN_LAUNCHER, SECOND_BRAIN_LIMITS,
	SECOND_BRAIN_PROTOCOL_VERSION, SECOND_BRAIN_READ_METHODS as READ_METHODS,
	SECOND_BRAIN_WRITE_METHOD as WRITE_METHOD, SecondBrainTransportError,
	isSecondBrainReadMethod as isRead, loadSecondBrainContract, normalizeSecondBrainOutcome,
	type SecondBrainCallOptions, type SecondBrainContractProfile, type SecondBrainDiagnostic, type SecondBrainDisposition,
	type SecondBrainExecFile, type SecondBrainMethod, type SecondBrainOutcome,
	type SecondBrainTimerHandle, type SecondBrainTimers, type SecondBrainTransport,
	type SecondBrainTransportOptions,
} from "./second-brain-transport-contract.js";
import {
	isSecondBrainRecord as isRecord, secondBrainRecord as record,
	type SecondBrainErrorCorrelation as ErrorCorrelation,
	type SecondBrainGenerationState as GenerationState, type SecondBrainPending as Pending,
	type SecondBrainQueueItem as QueueItem,
} from "./second-brain-transport-state.js";
import { snapshotMemoryWriteArguments } from "./memory-effect-write-request.js";
export {
	SECOND_BRAIN_CONFIG, SECOND_BRAIN_CONTRACT_PROFILE, SECOND_BRAIN_DEADLINES,
	SECOND_BRAIN_FRAME_BYTES, SECOND_BRAIN_LAUNCHER, SECOND_BRAIN_LIMITS,
	SECOND_BRAIN_PROTOCOL_VERSION, SecondBrainTransportError,
	normalizeSecondBrainToolSchemas,
} from "./second-brain-transport-contract.js";
export type {
	SecondBrainCallOptions, SecondBrainContractProfile, SecondBrainDiagnostic, SecondBrainDisposition, SecondBrainExecFile,
	SecondBrainExecFileOptions, SecondBrainMethod, SecondBrainOutcome, SecondBrainReadMethod,
	SecondBrainTimerHandle, SecondBrainTimers, SecondBrainTransport, SecondBrainTransportOptions,
} from "./second-brain-transport-contract.js";

const SECOND_BRAIN_SHUTDOWN_GRACE_MS = 1_000;

class SupervisedSecondBrainTransport implements SecondBrainTransport {
	// Mutable fields are the transport generation, request registry, and bounded schedulers they supervise.
	private child: ChildProcess | undefined; private poisonedChild: ChildProcess | undefined; private terminalFailure: SecondBrainTransportError | undefined;
	private generation = 0; private sequence = 0; private buffer = Buffer.alloc(0); private stderrBuffer = Buffer.alloc(0); private stderrBytes = 0;
	private stderrEvents = 0; private starting: Promise<void> | undefined; private terminating: Promise<void> | undefined;
	private restarting: Promise<void> | undefined; private closing: Promise<void> | undefined; private closed = false; private state: GenerationState = "idle";
	private localArguments = false; private admissionTail: Promise<void> = Promise.resolve(); private readonly pending = new Map<string, Pending>();
	private readonly seen = new Set<string>(); private readonly retired = new Set<string>(); private readonly events: SecondBrainDiagnostic[] = [];
	private readonly readQueue: QueueItem[] = []; private readonly writeQueue: QueueItem[] = [];
	private readonly stopping = new WeakMap<ChildProcess, Promise<void>>(); private activeReads = 0; private activeWrites = 0; private readonly launcher: string;
	private readonly config: string; private readonly run: SecondBrainExecFile; private readonly resolvePath: (path: string) => string;
	private readonly timers: SecondBrainTimers; private readonly now: () => number; private readonly deadlines: Readonly<typeof SECOND_BRAIN_DEADLINES>;
	private readonly profile: SecondBrainContractProfile;
	private readonly retries: 0 | 1;
	private readonly shutdownGrace: number;
	private readonly contract: unknown;
	private readonly report?: (diagnostic: SecondBrainDiagnostic) => void; constructor(options: SecondBrainTransportOptions) {
		this.launcher = options.launcherPath ?? SECOND_BRAIN_LAUNCHER; this.config = options.configPath ?? SECOND_BRAIN_CONFIG; this.run = options.execFile ??
			((file, args, childOptions) => nodeExecFile(file, [...args], childOptions)); this.resolvePath = options.realpath ?? realpathSync;
		this.timers = options.timers ?? { set: (callback, delay) => setTimeout(callback, delay), clear: (handle) => clearTimeout(handle), };
		this.now = options.clock ?? Date.now; this.deadlines = options.deadlines ?? SECOND_BRAIN_DEADLINES; this.retries = options.safeReadRetries ?? 1;
		this.shutdownGrace = options.shutdownGraceMs ?? SECOND_BRAIN_SHUTDOWN_GRACE_MS; this.profile = options.contractProfile ?? SECOND_BRAIN_CONTRACT_PROFILE;
		this.contract = loadSecondBrainContract(options.contractPath, this.profile);
		this.report = options.onDiagnostic; } diagnostics(): readonly SecondBrainDiagnostic[] { return this.events.map((item) => ({ ...item })); } call(
		method: SecondBrainMethod, arguments_: Readonly<Record<string, unknown>>, options: SecondBrainCallOptions = {}, ): Promise<SecondBrainOutcome> {
		if (this.terminalFailure) return Promise.reject(this.terminalFailure); if (![...READ_METHODS, WRITE_METHOD, "sb_submit_cancellation"].includes(method))
			return Promise.reject(this.error("SECOND_BRAIN_METHOD_DENIED", "fatal"));
		const snapshot = method === WRITE_METHOD
			? snapshotMemoryWriteArguments(arguments_) : snapshotArguments(arguments_); if (!snapshot)
			return Promise.reject( this.error("SECOND_BRAIN_INVALID_ARGUMENTS", "fatal", { method }), );
		if (method === "sb_submit_cancellation" && (Object.keys(snapshot).length !== 1 || !isRecord(snapshot.intent)))
			return Promise.reject(this.error("SECOND_BRAIN_INVALID_ARGUMENTS", "fatal", { method }));
		if (method === WRITE_METHOD && isRecord(snapshot.request) && snapshot.request.schema_version === 3
			&& this.profile !== "remember-schema5" && this.profile !== "cancellation-schema6" && this.profile !== "cancellation-submit-schema7") return Promise.reject(this.error("SECOND_BRAIN_CONTRACT_PROFILE_REQUIRED", "fatal", { method }));
		if (method === "sb_cancellation_status" && this.profile !== "cancellation-schema6" && this.profile !== "cancellation-submit-schema7")
			return Promise.reject(this.error("SECOND_BRAIN_CONTRACT_PROFILE_REQUIRED", "fatal", { method }));
		if (method === "sb_submit_cancellation" && this.profile !== "cancellation-submit-schema7")
			return Promise.reject(this.error("SECOND_BRAIN_CONTRACT_PROFILE_REQUIRED", "fatal", { method }));
		if ((this.profile === "scoped-record-read-v1" || this.profile === "scoped-record-read-v2") && !frozenArgumentsMatch(method, snapshot, this.contract))
			return Promise.reject(this.error("SECOND_BRAIN_INVALID_ARGUMENTS", "fatal", { method }));
		let argumentBytes: number; try {
			argumentBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8"); } catch { return Promise.reject(
				this.error("SECOND_BRAIN_INVALID_ARGUMENTS", "fatal", { method }), ); }
		const maxArgumentBytes = method === "sb_submit_cancellation" ? 16_395 : SECOND_BRAIN_LIMITS.argument_bytes;
		if (argumentBytes > maxArgumentBytes || (this.localArguments && isRead(method) &&
				!frozenArgumentsMatch(method, snapshot, this.contract)) ) return Promise.reject( this.error( argumentBytes > maxArgumentBytes
						? "SECOND_BRAIN_ARGUMENTS_OVERSIZE" : "SECOND_BRAIN_INVALID_ARGUMENTS", "fatal", { method }, ), );
		const queue = isRead(method) ? this.readQueue : this.writeQueue; const limit = isRead(method) ? SECOND_BRAIN_LIMITS.read_queue
			: SECOND_BRAIN_LIMITS.write_queue; if (queue.length >= limit) return Promise.reject( this.error("SECOND_BRAIN_QUEUE_SATURATED", "unavailable", { method }),
			); return new Promise((resolve, reject) => { const item: QueueItem = { method, arguments_: snapshot, options, resolve, reject, cancelled: false,
				settled: false, }; if (options.signal?.aborted) { item.cancelled = true; item.settled = true;
				reject(this.error("SECOND_BRAIN_CANCELLED", "cancelled", { method })); return; } if (options.signal) { item.abort = () => { if (item.settled) return;
					item.cancelled = true; item.settled = true; const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1);
					reject(this.error("SECOND_BRAIN_CANCELLED", "cancelled", { method })); this.pump(); };
				options.signal.addEventListener("abort", item.abort, { once: true }); } queue.push(item); this.pump(); }); } private pump(): void {
		while (!this.closed && this.activeReads < 4 && this.readQueue.length > 0) { const item = this.readQueue.shift(); if (!item) break; this.activeReads += 1;
			this.dispatch(item).finally(() => { this.activeReads -= 1; this.pump(); }); } if (!this.closed && this.activeWrites === 0) {
			const item = this.writeQueue.shift(); if (item) { this.activeWrites = 1; this.dispatch(item).finally(() => { this.activeWrites = 0; this.pump(); }); } } }
	private async dispatch(item: QueueItem): Promise<void> { let attempt = 0; for (;;) { try { await this.ensureStarted(); const raw = await this.admit(item);
				const outcome = normalizeSecondBrainOutcome(item.method, raw); if (!item.settled) {
					item.settled = true; item.resolve(outcome); } return; } catch (caught) { const error =
					caught instanceof SecondBrainTransportError ? caught : this.error("SECOND_BRAIN_START_FAILED", "unavailable"); if ( isRead(item.method) &&
					error.code === "SECOND_BRAIN_CHILD_EXIT" && attempt < this.retries ) { attempt += 1; continue; } if (!item.settled) { item.settled = true;
					item.reject(error); } return; } } } private async admit(item: QueueItem): Promise<Record<string, unknown>> { const previous = this.admissionTail;
		let release = (): void => undefined; this.admissionTail = new Promise<void>((resolve) => { release = resolve; }); await previous;
		let response: Promise<Record<string, unknown>>; try { await this.ensureCorrelationCapacity(); if (item.abort && item.options.signal)
				item.options.signal.removeEventListener("abort", item.abort); if (item.cancelled || item.options.signal?.aborted)
				throw this.error("SECOND_BRAIN_CANCELLED", "cancelled", { method: item.method, }); if ( this.localArguments && isRead(item.method) &&
				!frozenArgumentsMatch(item.method, item.arguments_, this.contract) ) throw this.error("SECOND_BRAIN_INVALID_ARGUMENTS", "fatal", { method: item.method, });
			item.options.beforeSend?.();
			response = this.request( item.method, item.arguments_, item.options.signal, isRead(item.method) ? this.deadlines.read : this.deadlines.write, ); } finally {
			release(); } return response; } private async ensureCorrelationCapacity(): Promise<void> { if ( this.sequence < SECOND_BRAIN_LIMITS.correlation_ids &&
			this.pending.size + this.seen.size + this.retired.size < SECOND_BRAIN_LIMITS.correlation_ids ) return; if (!this.terminating) { this.state = "failed";
			this.settleGeneration( this.error("SECOND_BRAIN_CORRELATION_SATURATED", "unavailable"), ); const old = this.child;
			const stopping = this.stop(old).then(() => { if (this.child === old) this.child = undefined; this.state = "idle"; }); this.terminating = stopping;
			void stopping.then( () => { if (this.terminating === stopping) this.terminating = undefined; }, () => undefined, ); } await this.terminating;
		await this.ensureStarted(); } private async ensureStarted(): Promise<void> { if (this.terminalFailure) throw this.terminalFailure;
		if (this.state === "ready" && this.child) return; if (this.terminating) await this.terminating; if (!this.starting)
			this.starting = this.start().finally(() => { this.starting = undefined; }); return this.starting; } private async start(): Promise<void> {
		if (this.terminalFailure) throw this.terminalFailure; if (this.closed) throw this.error("SECOND_BRAIN_CLOSED", "unavailable"); let target: string; try {
			target = this.resolvePath(this.launcher); } catch { throw this.error("SECOND_BRAIN_DISCOVERY_FAILED", "unavailable"); } this.generation += 1;
		this.sequence = 0; this.buffer = Buffer.alloc(0); this.stderrBuffer = Buffer.alloc(0); this.stderrBytes = 0; this.stderrEvents = 0; this.state = "starting";
		this.localArguments = false; this.seen.clear(); this.retired.clear(); if (this.child) throw this.error("SECOND_BRAIN_SHUTDOWN_FAILED", "fatal");
		const child = this.run(target, [], { encoding: "buffer", shell: false,
			env: { SB_CONFIG: this.config, SB_MCP_CONTRACT_PROFILE: this.profile },
			windowsHide: true, }); this.child = child;
		// A pipe error is asynchronous and can arrive while the old child is stopping.
		const onInputError = (): void => {
			if (this.child === child && !this.closed && this.state !== "failed")
				this.fail(this.error("SECOND_BRAIN_CHILD_EXIT", "unavailable"));
		};
		child.stdin?.on("error", onInputError);
		child.once("close", () => child.stdin?.off("error", onInputError));
		child.stdout?.removeAllListeners("data"); child.stderr?.removeAllListeners("data"); child.stdout?.on("data", this.onData);
		child.stderr?.on("data", this.onStderr); child.once("error", this.onStartError); child.once("close", this.onClose); try {
			const initialize = await this.request( undefined, { protocolVersion: SECOND_BRAIN_PROTOCOL_VERSION, capabilities: {},
					clientInfo: { name: "orca-jarvis", version: "1" }, }, undefined, this.deadlines.startup, "initialize", ); const server = record(initialize.serverInfo);
			if ( initialize.protocolVersion !== SECOND_BRAIN_PROTOCOL_VERSION || server.name !== "second-brain" || typeof server.version !== "string" )
				throw this.error("SECOND_BRAIN_VERSION_MISMATCH", "fatal"); this.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {}, });
			const listed = await this.request( undefined, {}, undefined, this.deadlines.startup, "tools/list", );
			const schemas = inspectFrozenSchemas(listed.tools, this.contract); if (!schemas.matches) throw this.error("SECOND_BRAIN_SCHEMA_MISMATCH", "fatal");
			this.localArguments = schemas.requiresLocalArguments; this.state = "ready"; this.emit({ code: "SECOND_BRAIN_STARTED", generation: this.generation,
				pending_count: this.pending.size, protocol_version: SECOND_BRAIN_PROTOCOL_VERSION, server_name: "second-brain", server_version: server.version, });
		} catch (caught) { const error = caught instanceof SecondBrainTransportError ? this.error(caught.code, caught.disposition, { method: caught.method,
							request_id: caught.request_id, }) : this.error("SECOND_BRAIN_START_FAILED", "unavailable"); this.fail(error); await this.stop(child); throw error; } }
	private request( method: SecondBrainMethod | undefined, arguments_: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, timeout: number,
		protocolMethod = "tools/call", ): Promise<Record<string, unknown>> { if (signal?.aborted) throw this.error("SECOND_BRAIN_CANCELLED", "cancelled", { method });
		if (this.pending.size >= SECOND_BRAIN_LIMITS.pending) return Promise.reject( this.error("SECOND_BRAIN_PENDING_SATURATED", "unavailable", { method }), );
		const id = `${this.generation}:${++this.sequence}`; const params = protocolMethod === "tools/call" ? { name: method, arguments: arguments_ } : arguments_;
		const frame = this.encode({ jsonrpc: "2.0", id, method: protocolMethod, params, }); return new Promise((resolve, reject) => {
			const timer = this.timers.set(() => { const pending = this.pending.get(id); if (!pending) return; this.pending.delete(id); this.detach(pending);
				this.retire(id); this.cancel(id); const write = pending.write && pending.dispatched; reject( this.error( write ? "SECOND_BRAIN_WRITE_TIMEOUT" : method
								? "SECOND_BRAIN_READ_TIMEOUT" : "SECOND_BRAIN_STARTUP_TIMEOUT", write ? "uncertain" : "unavailable", { method, request_id: id }, ), ); }, timeout);
			const pending: Pending = { id, method, write: method !== undefined && !isRead(method), dispatched: false, started: this.now(), resolve, reject, timer, signal, };
			if (signal) { pending.abort = () => { if (!this.pending.delete(id)) return; this.detach(pending); this.retire(id); this.cancel(id);
					const uncertain = pending.write && pending.dispatched; reject( this.error( uncertain ? "SECOND_BRAIN_WRITE_INTERRUPTED" : "SECOND_BRAIN_CANCELLED",
							uncertain ? "uncertain" : "cancelled", { method, request_id: id }, ), ); }; signal.addEventListener("abort", pending.abort, { once: true }); }
			this.pending.set(id, pending); if (signal?.aborted) { pending.abort?.(); return; } try { this.write(frame); pending.dispatched = true; if (method)
					this.emit({ code: "SECOND_BRAIN_REQUESTED", generation: this.generation, method, request_id: id, pending_count: this.pending.size, }); } catch (caught) {
				this.pending.delete(id); this.detach(pending); reject( caught instanceof SecondBrainTransportError ? caught
						: this.error("SECOND_BRAIN_CHILD_EXIT", "unavailable", { method, request_id: id, }), ); } }); }
	private encode(message: Readonly<Record<string, unknown>>): Buffer { const body = Buffer.from(JSON.stringify(message), "utf8");
		if (body.byteLength + 1 > SECOND_BRAIN_FRAME_BYTES) throw this.error("SECOND_BRAIN_OVERSIZE_FRAME", "fatal"); return Buffer.concat([body, Buffer.from("\n")]);
	} private cancel(id: string): void { if (!this.child?.stdin?.writable) return; this.child.stdin.write( this.encode({ jsonrpc: "2.0",
				method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" }, }), ); } private write(frame: Buffer): void {
		if (!this.child?.stdin?.writable) throw this.error("SECOND_BRAIN_CHILD_EXIT", "unavailable"); this.child.stdin.write(frame); }
	private send(message: Readonly<Record<string, unknown>>): void { this.write(this.encode(message)); }
	private readonly onData = (chunk: Buffer | string): void => { this.buffer = Buffer.concat([ this.buffer,
			typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk, ]); for (;;) { const newline = this.buffer.indexOf(10); if (newline < 0) break;
			if (newline + 1 > SECOND_BRAIN_FRAME_BYTES) { this.fail(this.error("SECOND_BRAIN_OVERSIZE_FRAME", "fatal")); return; }
			let frame = this.buffer.subarray(0, newline); this.buffer = this.buffer.subarray(newline + 1);
			if (frame.at(-1) === 13) frame = frame.subarray(0, frame.byteLength - 1); if (frame.byteLength > SECOND_BRAIN_FRAME_BYTES) {
				this.fail(this.error("SECOND_BRAIN_OVERSIZE_FRAME", "fatal")); return; } this.frame(frame); } if (this.buffer.byteLength >= SECOND_BRAIN_FRAME_BYTES)
			this.fail(this.error("SECOND_BRAIN_OVERSIZE_FRAME", "fatal")); }; private frame(frame: Buffer): void { let text: string; try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(frame); } catch (caught) {
			if (caught instanceof TypeError) this.fail(this.error("SECOND_BRAIN_INVALID_UTF8", "fatal"));
			else throw caught; return; }
		const parsed = parseSecondBrainStrictJson(text); if ( !isRecord(parsed) || parsed.jsonrpc !== "2.0" ||
			typeof parsed.id !== "string" ) { this.fail(this.error("SECOND_BRAIN_MALFORMED_FRAME", "fatal")); return; } const resultEnvelope =
			Object.keys(parsed).sort().join("\0") === "id\0jsonrpc\0result"; const errorEnvelope = Object.keys(parsed).sort().join("\0") === "error\0id\0jsonrpc"; if (
			resultEnvelope === errorEnvelope || (errorEnvelope && !this.validProtocolError(parsed.error)) || (resultEnvelope && !isRecord(parsed.result)) ) {
			this.fail(this.error("SECOND_BRAIN_MALFORMED_FRAME", "fatal")); return; } const id = parsed.id; if (this.retired.delete(id)) return;
		const pending = this.pending.get(id); if (!pending) { this.fail( this.error( this.seen.has(id) ? "SECOND_BRAIN_DUPLICATE_FRAME"
						: "SECOND_BRAIN_UNMATCHED_FRAME", "fatal", { request_id: id }, ), ); return; } this.pending.delete(id); this.complete(id); this.detach(pending);
		if (errorEnvelope) pending.reject( this.error( "SECOND_BRAIN_PROTOCOL_ERROR", pending.write ? "uncertain" : "unavailable",
					{ method: pending.method, request_id: id }, ), ); else pending.resolve(record(parsed.result)); } private validProtocolError(value: unknown): boolean { if (
			!isRecord(value) || !Number.isInteger(value.code) || typeof value.message !== "string" ) return false; const keys = Object.keys(value).sort().join("\0");
		return keys === "code\0message" || keys === "code\0data\0message"; } private complete(id: string): void { this.seen.add(id); }
	private readonly onStderr = (chunk: Buffer | string): void => { const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		this.stderrBytes = Math.min( SECOND_BRAIN_LIMITS.stderr_bytes, this.stderrBytes + bytes.byteLength, );
		const combined = Buffer.concat([this.stderrBuffer, bytes]); const newline = combined.lastIndexOf(10);
		const partial = newline < 0 ? combined : combined.subarray(newline + 1); this.stderrBuffer = partial.subarray( Math.max(0, partial.byteLength - 4_096), );
		const delimiters = bytes.reduce( (count, byte) => count + (byte === 10 ? 1 : 0), 0, ); const count = Math.min( Math.max(1, delimiters),
			Math.max(0, 64 - this.stderrEvents), ); for (let index = 0; index < count; index += 1) { this.stderrEvents += 1; this.emit({ code: "SECOND_BRAIN_STDERR",
				generation: this.generation, stderr_bytes: this.stderrBytes, stderr_buffer_bytes: this.stderrBuffer.byteLength, }); } };
	private readonly onStartError = (): void => { this.fail(this.error("SECOND_BRAIN_START_FAILED", "unavailable")); }; private readonly onClose = (): void => {
		if (this.closed || this.state === "failed") return; const error = this.buffer.byteLength > 0 ? this.error("SECOND_BRAIN_PARTIAL_FRAME", "fatal")
				: this.error("SECOND_BRAIN_CHILD_EXIT", "unavailable"); this.state = "failed"; this.settleGeneration(error); this.emit({ code: error.code,
			generation: this.generation, pending_count: 0, stderr_bytes: this.stderrBytes, }); this.child = undefined; }; private detach(pending: Pending): void {
		this.timers.clear(pending.timer); if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort); }
	private retire(id: string): void { this.retired.add(id); } private settleGeneration(error: SecondBrainTransportError): void {
		for (const pending of [...this.pending.values()]) { this.pending.delete(pending.id); this.detach(pending); pending.reject( pending.write && pending.dispatched
					? this.error("SECOND_BRAIN_WRITE_INTERRUPTED", "uncertain", { method: pending.method, request_id: pending.id, }) : error, ); } this.retired.clear(); }
	private fail(error: SecondBrainTransportError): void { if (this.state === "failed") return; this.state = "failed"; this.settleGeneration(error); this.emit({
			code: error.code, generation: this.generation, request_id: error.request_id, pending_count: 0, stderr_bytes: this.stderrBytes, }); const child = this.child;
		if (child) { const terminating = this.stop(child); this.terminating = terminating; void terminating.then( () => {
					if (this.child === child) this.child = undefined; if (this.terminating === terminating) this.terminating = undefined; }, () => undefined, ); } }
	private poison(child: ChildProcess, error: SecondBrainTransportError): void { if (this.terminalFailure) return; this.terminalFailure = error;
		this.poisonedChild = child; this.state = "failed"; this.settleGeneration(error); for (const item of [...this.readQueue, ...this.writeQueue]) {
			if (item.abort && item.options.signal) item.options.signal.removeEventListener("abort", item.abort); if (!item.settled) { item.settled = true;
				item.reject(error); } } this.readQueue.length = 0; this.writeQueue.length = 0; this.buffer = Buffer.alloc(0); this.stderrBuffer = Buffer.alloc(0);
		this.stderrBytes = 0; this.seen.clear(); this.retired.clear(); child.once("close", () => { if (this.poisonedChild !== child || this.child !== child) return;
			this.poisonedChild = undefined; this.terminalFailure = undefined; this.terminating = undefined; this.child = undefined; this.state = "idle"; }); this.emit({
			code: error.code, generation: this.generation, pending_count: 0, queued_count: 0, listener_count: 0, timer_count: 0, process_state: "unconfirmed_live",
			process_owned: true, }); } private stop(child: ChildProcess | undefined): Promise<void> { if (!child) return Promise.resolve();
		const existing = this.stopping.get(child); if (existing) return existing; child.stdout?.off("data", this.onData); child.stderr?.off("data", this.onStderr);
		child.off("error", this.onStartError); child.off("close", this.onClose); const stopping = new Promise<void>((resolve, reject) => {
			const shutdown: { handle: SecondBrainTimerHandle | undefined } = { handle: undefined, }; let settled = false;
			const finish = (error?: SecondBrainTransportError): void => { if (settled) return; settled = true; child.off("close", closed);
				if (shutdown.handle !== undefined) this.timers.clear(shutdown.handle); if (error) reject(error); else resolve(); }; const closed = (): void => finish();
			child.once("close", closed); if (child.exitCode !== null || child.signalCode !== null) { finish(); return; } const escalate = (): void => {
				if (settled) return; this.emit({ code: "SECOND_BRAIN_SIGKILL", generation: this.generation, }); const signalled = child.kill("SIGKILL");
				shutdown.handle = this.timers.set(() => { const error = this.error("SECOND_BRAIN_SHUTDOWN_FAILED", "fatal"); finish(error); this.poison(child, error);
				}, this.shutdownGrace); if (!signalled) this.emit({ code: "SECOND_BRAIN_SIGNAL_FAILED", generation: this.generation, }); };
			const signalled = child.kill("SIGTERM"); if (signalled) shutdown.handle = this.timers.set(escalate, this.shutdownGrace); else escalate(); });
		this.stopping.set(child, stopping); return stopping; } private emit(event: SecondBrainDiagnostic): void { const enriched = {
			buffer_bytes: this.buffer.byteLength, correlation_count: this.pending.size + this.seen.size + this.retired.size,
			stderr_buffer_bytes: this.stderrBuffer.byteLength, ...event, }; if (this.events.length === SECOND_BRAIN_LIMITS.diagnostics) this.events.shift();
		this.events.push(enriched); this.report?.({ ...enriched }); } private error( code: string, disposition: SecondBrainDisposition,
		context: Omit<ErrorCorrelation, "generation"> = {}, ): SecondBrainTransportError { return new SecondBrainTransportError(code, disposition, {
			generation: this.generation, ...context, }); } restart(): Promise<void> { if (this.terminalFailure) return Promise.reject(this.terminalFailure);
		if (!this.restarting) { const restart = this.restartTransport(); this.restarting = restart; void restart.then( () => {
					if (this.restarting === restart) this.restarting = undefined; }, () => { if (this.restarting === restart) this.restarting = undefined; }, ); }
		return this.restarting; } private async restartTransport(): Promise<void> { const old = this.child; this.state = "failed";
		this.settleGeneration(this.error("SECOND_BRAIN_CHILD_EXIT", "unavailable")); try { await this.stop(old); } catch (caught) { this.buffer = Buffer.alloc(0);
			this.stderrBuffer = Buffer.alloc(0); this.seen.clear(); this.retired.clear(); throw caught; } if (this.child === old) this.child = undefined;
		this.state = "idle"; await this.ensureStarted(); } close(): Promise<void> { if (this.terminalFailure) return Promise.reject(this.terminalFailure);
		if (!this.closing) { this.closed = true; this.closing = this.closeTransport(); } return this.closing; } private async closeTransport(): Promise<void> {
		this.state = "failed"; this.settleGeneration(this.error("SECOND_BRAIN_CLOSED", "unavailable")); for (const item of [...this.readQueue, ...this.writeQueue]) {
			if (item.abort && item.options.signal) item.options.signal.removeEventListener("abort", item.abort); if (!item.settled) { item.settled = true; item.reject(
					this.error("SECOND_BRAIN_CLOSED", "unavailable", { method: item.method, }), ); } } this.readQueue.length = 0; this.writeQueue.length = 0;
		const child = this.child; let failure: SecondBrainTransportError | undefined; try { await Promise.all([ this.terminating ?? Promise.resolve(),
				this.stop(child), ]); if (this.child === child) this.child = undefined; } catch (caught) {
			if (caught instanceof SecondBrainTransportError) failure = caught; else throw caught; } finally {
			if (!failure && this.child === child) child?.removeAllListeners("close"); this.buffer = Buffer.alloc(0); this.stderrBuffer = Buffer.alloc(0);
			this.seen.clear(); this.retired.clear(); if (!failure) this.emit({ code: "SECOND_BRAIN_CLOSED", generation: this.generation, pending_count: 0,
					queued_count: 0, listener_count: 0, timer_count: 0, }); } if (failure) throw failure; } }

export function createSecondBrainTransport( options: SecondBrainTransportOptions = {}, ): SecondBrainTransport {
	const profile = options.contractProfile ?? process.env["JARVIS_SECOND_BRAIN_CONTRACT_PROFILE"]
		?? SECOND_BRAIN_CONTRACT_PROFILE;
	if (profile !== "scoped-record-read-v2" && profile !== "scoped-record-read-v1" && profile !== "task32-schema4" && profile !== "remember-schema5" && profile !== "cancellation-schema6" && profile !== "cancellation-submit-schema7") {
		throw new SecondBrainTransportError("SECOND_BRAIN_CONTRACT_PROFILE_INVALID", "fatal", { generation: 0 });
	}
	return new SupervisedSecondBrainTransport({ ...options, contractProfile: profile });
}
