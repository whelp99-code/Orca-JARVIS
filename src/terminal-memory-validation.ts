import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { TerminalEventKind, TerminalHostId, TerminalOutcome } from "./terminal-memory-types.js";

export class TerminalMemoryError extends Error {
	constructor(
		readonly code: string,
		message = code,
	) {
		super(message);
	}
}

const HOSTS: readonly TerminalHostId[] = ["host:pos:linux-control-plane", "host:pos:linux-second-brain", "host:pos:mac-client", "host:pos:phone-client"];
const KINDS: readonly TerminalEventKind[] = ["command", "test", "build", "git", "agent", "lifecycle", "checkpoint"];
const OUTCOMES: readonly TerminalOutcome[] = ["succeeded", "failed", "cancelled", "timeout", "uncertain", "skipped"];
const SECRET = /(password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization)\s*[:=]/i;

export function terminalDigest(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

export function text(value: unknown, max: number, code = "TERMINAL_INPUT_INVALID"): string {
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > max) {
		throw new TerminalMemoryError(code);
	}
	return value;
}

export function optionalText(value: unknown, max: number): string | null {
	if (value === null || value === undefined) return null;
	return text(value, max);
}

export function timestamp(value: unknown): string {
	const parsed = text(value, 64);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed) || !Number.isFinite(Date.parse(parsed)) || new Date(parsed).toISOString() !== parsed) {
		throw new TerminalMemoryError("TERMINAL_TIMESTAMP_INVALID");
	}
	return parsed;
}

export function identifier(value: unknown, max = 256): string {
	return text(value, max).includes("\u0000")
		? (() => {
				throw new TerminalMemoryError("TERMINAL_ID_INVALID");
			})()
		: text(value, max);
}

export function host(value: unknown): TerminalHostId {
	if (typeof value !== "string" || !HOSTS.includes(value as TerminalHostId)) throw new TerminalMemoryError("TERMINAL_HOST_INVALID");
	return value as TerminalHostId;
}

export function eventKind(value: unknown): TerminalEventKind {
	if (typeof value !== "string" || !KINDS.includes(value as TerminalEventKind)) throw new TerminalMemoryError("TERMINAL_EVENT_KIND_INVALID");
	return value as TerminalEventKind;
}

export function outcome(value: unknown): TerminalOutcome {
	if (typeof value !== "string" || !OUTCOMES.includes(value as TerminalOutcome)) throw new TerminalMemoryError("TERMINAL_OUTCOME_INVALID");
	return value as TerminalOutcome;
}

export function boundedEvidence(value: unknown, maxBytes = 64 * 1024): string | null {
	if (value === null || value === undefined) return null;
	const candidate = text(value, maxBytes);
	if (candidate.split("\n").length > 200) throw new TerminalMemoryError("TERMINAL_EVIDENCE_LIMIT");
	return candidate;
}

export function safeSummary(value: unknown): string {
	const summary = text(value, 1024);
	if (SECRET.test(summary) || summary.includes("\u0000")) throw new TerminalMemoryError("TERMINAL_REDACTION_REQUIRED");
	return summary;
}

export function jsonList(values: readonly string[], maxItems = 64): string {
	if (values.length > maxItems || values.some((value) => typeof value !== "string" || Buffer.byteLength(value, "utf8") > 512)) {
		throw new TerminalMemoryError("TERMINAL_LIST_LIMIT");
	}
	return canonicalize(values);
}
