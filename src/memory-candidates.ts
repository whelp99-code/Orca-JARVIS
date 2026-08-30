import type Database from "better-sqlite3";
import { TerminalMemoryError } from "./terminal-memory-validation.js";
import { terminalDigest, text, timestamp, identifier, safeSummary } from "./terminal-memory-validation.js";

export type MemoryCandidateOrigin =
	| "explicit_user"
	| "verified_outcome"
	| "approved_decision"
	| "labeled_inference"
	| "agent_assertion"
	| "raw_transcript"
	| "transient_runtime";
export type CandidateSensitivity = "normal" | "sensitive" | "restricted";
export type CandidateConfidence = "verified" | "confirmed" | "inferred";
export type CandidateClassificationInput = Readonly<{
	candidate_id: string;
	correlation_id: string;
	idempotency_key: string;
	origin: MemoryCandidateOrigin;
	operation: "remember" | "correct" | "forget" | "export";
	content?: string | null;
	target_digest?: string | null;
	source_refs: readonly string[];
	source_digest?: string;
	sensitivity: CandidateSensitivity;
	confidence: CandidateConfidence;
	purpose: string;
	expires_at: string;
	confirmation_expires_at?: string | null;
	now: string;
	second_brain_state?: "fresh" | "no_data" | "offline" | "stale";
}>;
export type MemoryCandidateResult = Readonly<{
	candidate_id: string;
	state: "classified" | "awaiting_confirmation" | "rejected";
	required_confirmation: boolean;
	content_digest: string;
	source_digest: string;
	delivery_state: "ready" | "pending";
	reason: string | null;
}>;

const dbOf = (source: Database.Database | Readonly<{ db: Database.Database }>): Database.Database => ("db" in source ? source.db : source);
const REJECTED: readonly MemoryCandidateOrigin[] = ["agent_assertion", "raw_transcript", "transient_runtime"];
const CLASSIFIABLE: readonly MemoryCandidateOrigin[] = ["explicit_user", "verified_outcome", "approved_decision", "labeled_inference"];
const levels: readonly CandidateSensitivity[] = ["normal", "sensitive", "restricted"];
const confidences: readonly CandidateConfidence[] = ["verified", "confirmed", "inferred"];

export class MemoryCandidateClassifier {
	private readonly db: Database.Database;
	constructor(source: Database.Database | Readonly<{ db: Database.Database }>) {
		this.db = dbOf(source);
	}

	classify(input: CandidateClassificationInput): MemoryCandidateResult {
		const now = timestamp(input.now);
		const expires = timestamp(input.expires_at);
		identifier(input.candidate_id);
		identifier(input.correlation_id);
		identifier(input.idempotency_key);
		if (Date.parse(expires) <= Date.parse(now) || !levels.includes(input.sensitivity) || !confidences.includes(input.confidence))
			throw new TerminalMemoryError("MEMORY_CANDIDATE_POLICY_INVALID");
		if (!CLASSIFIABLE.includes(input.origin)) {
			if (REJECTED.includes(input.origin)) return this.reject(input, now, "MEMORY_SOURCE_UNVERIFIED");
			throw new TerminalMemoryError("MEMORY_CANDIDATE_ORIGIN_INVALID");
		}
		if (input.source_refs.length === 0 || input.source_refs.length > 64) throw new TerminalMemoryError("MEMORY_SOURCE_REFS_INVALID");
		const sourceDigest = input.source_digest ?? terminalDigest(input.source_refs);
		const content = input.content === null || input.content === undefined ? null : safeSummary(input.content);
		const contentDigest = terminalDigest(content ?? input.target_digest ?? input.candidate_id);
		const required = input.sensitivity !== "normal" || input.confidence === "inferred" || input.origin === "labeled_inference";
		if (required && (input.confirmation_expires_at === null || input.confirmation_expires_at === undefined))
			throw new TerminalMemoryError("MEMORY_CONFIRMATION_REQUIRED");
		const confirmationExpires =
			input.confirmation_expires_at === null || input.confirmation_expires_at === undefined
				? null
				: timestamp(input.confirmation_expires_at);
		if (
			confirmationExpires !== null &&
			(Date.parse(confirmationExpires) <= Date.parse(now) || Date.parse(confirmationExpires) > Date.parse(expires))
		)
			throw new TerminalMemoryError("MEMORY_CONFIRMATION_INVALID");
		const state = required ? "awaiting_confirmation" : "classified";
		const candidate = {
			candidate_id: input.candidate_id,
			correlation_id: input.correlation_id,
			idempotency_key: input.idempotency_key,
			candidate_kind:
				input.origin === "explicit_user"
					? "user_instruction"
					: input.origin === "verified_outcome"
						? "verified_fact"
						: input.origin === "approved_decision"
							? "verified_fact"
							: "inference",
			operation: input.operation === "export" ? "remember" : input.operation,
			subject_digest: terminalDigest(input.target_digest ?? input.candidate_id),
			content_digest: contentDigest,
			source_digest: sourceDigest,
			sensitivity: input.sensitivity,
			purpose: text(input.purpose, 128),
			required_confirmation: required ? 1 : 0,
			state,
			confirmation_expires_at: confirmationExpires,
			expires_at: expires,
			created_at: now,
			updated_at: now,
		} as const;
		const prior = this.db
			.prepare("SELECT candidate_id,content_digest,source_digest,state FROM memory_candidates WHERE idempotency_key=?")
			.get(input.idempotency_key) as Record<string, unknown> | undefined;
		if (prior !== undefined) {
			if (prior.content_digest !== contentDigest || prior.source_digest !== sourceDigest)
				throw new TerminalMemoryError("MEMORY_CANDIDATE_REPLAY_CONFLICT");
			return {
				candidate_id: String(prior.candidate_id),
				state: String(prior.state) as MemoryCandidateResult["state"],
				required_confirmation: required,
				content_digest: contentDigest,
				source_digest: sourceDigest,
				delivery_state: "pending",
				reason: input.second_brain_state === "no_data" ? "SECOND_BRAIN_NO_DATA" : null,
			};
		}
		this.db.transaction(() => {
			this.db
				.prepare(`INSERT INTO memory_candidates
        (candidate_id,correlation_id,idempotency_key,candidate_kind,operation,subject_digest,content_digest,
         source_digest,sensitivity,purpose,required_confirmation,state,confirmation_expires_at,expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
				.run(
					candidate.candidate_id,
					candidate.correlation_id,
					candidate.idempotency_key,
					candidate.candidate_kind,
					candidate.operation,
					candidate.subject_digest,
					candidate.content_digest,
					candidate.source_digest,
					candidate.sensitivity,
					candidate.purpose,
					candidate.required_confirmation,
					"proposed",
					candidate.confirmation_expires_at,
					candidate.expires_at,
					candidate.created_at,
					candidate.updated_at,
				);
			this.db
				.prepare("UPDATE memory_candidates SET state=?,updated_at=? WHERE candidate_id=? AND state='proposed'")
				.run(state, now, candidate.candidate_id);
		})();
		return {
			candidate_id: input.candidate_id,
			state,
			required_confirmation: required,
			content_digest: contentDigest,
			source_digest: sourceDigest,
			delivery_state: input.second_brain_state === "no_data" || input.second_brain_state === "offline" ? "pending" : "ready",
			reason:
				input.second_brain_state === "no_data"
					? "SECOND_BRAIN_NO_DATA"
					: input.second_brain_state === "offline"
						? "SECOND_BRAIN_OFFLINE"
						: null,
		};
	}

	private reject(input: CandidateClassificationInput, now: string, reason: string): MemoryCandidateResult {
		const contentDigest = terminalDigest(input.content ?? input.target_digest ?? input.candidate_id);
		const sourceDigest = input.source_digest ?? terminalDigest(input.source_refs);
		this.db.transaction(() => {
			this.db
				.prepare(`INSERT INTO memory_candidates
        (candidate_id,correlation_id,idempotency_key,candidate_kind,operation,subject_digest,content_digest,
         source_digest,sensitivity,purpose,required_confirmation,state,expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
				.run(
					identifier(input.candidate_id),
					identifier(input.correlation_id),
					identifier(input.idempotency_key),
					"inference",
					input.operation === "export" ? "remember" : input.operation,
					terminalDigest(input.candidate_id),
					contentDigest,
					sourceDigest,
					input.sensitivity,
					text(input.purpose, 128),
					0,
					"proposed",
					timestamp(input.expires_at),
					now,
					now,
				);
			this.db
				.prepare("UPDATE memory_candidates SET state='rejected',updated_at=? WHERE candidate_id=? AND state='proposed'")
				.run(now, input.candidate_id);
		})();
		return {
			candidate_id: input.candidate_id,
			state: "rejected",
			required_confirmation: false,
			content_digest: contentDigest,
			source_digest: sourceDigest,
			delivery_state: "pending",
			reason,
		};
	}
}

export function classifyMemoryCandidate(
	source: Database.Database | Readonly<{ db: Database.Database }>,
	input: CandidateClassificationInput,
): MemoryCandidateResult {
	return new MemoryCandidateClassifier(source).classify(input);
}
