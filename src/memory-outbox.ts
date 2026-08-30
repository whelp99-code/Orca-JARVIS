import type Database from "better-sqlite3";
import {
	isSha256Digest,
	memoryOutboxRow,
	type MemoryOutboxQueueInput,
	type MemoryOutboxRow,
	type MemoryWriter,
	type MemoryWriteReceipt,
	type MemoryWriteRequest,
} from "./memory-outbox-contract.js";
import {
	bindMemoryProviderReceipt,
	memoryProviderReceiptConflicts,
	validateMemoryWriteReceipt,
} from "./memory-outbox-provider-binding.js";
import { claimMemoryOutbox, queueMemoryOutbox } from "./memory-outbox-queue.js";
import { latestMemoryOutboxAttempt, markMemoryOutboxUncertain } from "./memory-outbox-reconciliation.js";
import { TerminalMemoryError, identifier, terminalDigest, timestamp } from "./terminal-memory-validation.js";
import type { SqlSource } from "./terminal-work-memory.js";

export {
	UNBOUND_ARTIFACT_DIGEST,
	UNBOUND_ARTIFACT_SELECTOR,
	type MemoryOutboxQueueInput,
	type MemoryOutboxRow,
	type MemoryWriter,
	type MemoryWriteReceipt,
	type MemoryWriteRequest,
} from "./memory-outbox-contract.js";

const dbOf = (source: SqlSource): Database.Database => ("db" in source ? source.db : source);
const row = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

export class MemoryOutbox {
	private readonly db: Database.Database;
	constructor(source: SqlSource) {
		this.db = dbOf(source);
	}

	queue(input: MemoryOutboxQueueInput): MemoryOutboxRow {
		return this.output(queueMemoryOutbox(this.db, input));
	}

	claim(
		outboxId: string,
		owner: string,
		now: string,
		leaseMs = 30_000,
	): MemoryOutboxRow {
		return this.output(claimMemoryOutbox(this.db, outboxId, owner, now, leaseMs));
	}

	async deliver(outboxId: string, owner: string, fence: number, writer: MemoryWriter, now: string): Promise<MemoryOutboxRow> {
		const id = identifier(outboxId);
		const at = timestamp(now);
		const current = row(this.db.prepare("SELECT * FROM memory_outbox WHERE outbox_id=?").get(id));
		if (
			current === undefined ||
			current.state !== "delivering" ||
			current.lease_owner !== owner ||
			Number(current.lease_fence) !== fence ||
			Date.parse(String(current.lease_expires_at)) <= Date.parse(at)
		)
			throw new TerminalMemoryError("MEMORY_OUTBOX_STALE_FENCE");
		const request: MemoryWriteRequest = {
			outbox_id: id,
			candidate_id: String(current.candidate_id),
			idempotency_key: String(current.idempotency_key),
			operation: String(current.operation) as MemoryWriteRequest["operation"],
			request_digest: String(current.request_digest),
			expected_artifact_digest: String(current.expected_artifact_digest),
			expected_artifact_selector: String(current.expected_artifact_selector ?? ""),
			provider_version: String(current.provider_version ?? ""),
		};
		const rawResponse = await writer(request);
		const response = validateMemoryWriteReceipt(rawResponse);
		const invocation = terminalDigest({
			outbox_id: id,
			fence,
			request_digest: request.request_digest,
		});
		this.db.prepare(
			"INSERT INTO memory_outbox_attempts(attempt_id,outbox_id,lease_fence,"
      + "invocation_digest,outcome,error_code,created_at) VALUES(?,?,?,?,?,?,?)",
		).run(
			`attempt:${id}:${fence}`,
			id,
			fence,
			invocation,
			response.outcome,
			response.error_code ?? null,
			at,
		);
		if (response.outcome === "accepted") {
			const conflict = memoryProviderReceiptConflicts(request, response);
			const next = conflict ? "uncertain" : "accepted_unsettled";
			bindMemoryProviderReceipt(this.db, {
				outbox_id: id,
				owner,
				fence,
				receipt: response,
				at,
				next,
				lease_expires_at: String(current.lease_expires_at),
			});
		} else {
			const next = response.outcome === "uncertain" ? "uncertain" : "rejected";
			this.db.prepare(
				"UPDATE memory_outbox SET state=?,lease_owner=NULL,lease_expires_at=NULL,"
        + "updated_at=? WHERE outbox_id=? AND state='delivering' "
        + "AND lease_owner=? AND lease_fence=?",
			).run(next, at, id, owner, fence);
		}
		return this.output(row(this.db.prepare("SELECT * FROM memory_outbox WHERE outbox_id=?").get(id))!);
	}

	reconcile(outboxId: string, fence: number, observedArtifactDigest: string, now: string): MemoryOutboxRow {
		const id = identifier(outboxId);
		const at = timestamp(now);
		const digest = identifier(observedArtifactDigest, 256);
		const current = row(this.db.prepare("SELECT * FROM memory_outbox WHERE outbox_id=?").get(id));
		if (current === undefined) throw new TerminalMemoryError("MEMORY_OUTBOX_NOT_FOUND");
		if (
			current.state !== "accepted_unsettled" ||
			Number(current.lease_fence) !== fence ||
			current.lease_owner === null ||
			Date.parse(String(current.lease_expires_at)) <= Date.parse(at)
		)
			throw new TerminalMemoryError("MEMORY_OUTBOX_RECONCILIATION_REQUIRED");
		const providerDigest = current.provider_artifact_digest;
		const expected = isSha256Digest(providerDigest)
			? providerDigest
			: current.provider_version === "legacy"
				? String(current.expected_artifact_digest)
				: null;
		if (!expected) throw new TerminalMemoryError("MEMORY_OUTBOX_PROVIDER_RECEIPT_REQUIRED");
		const eventType = digest === expected ? "artifact_observed" : "conflict";
		this.db
			.prepare(`INSERT INTO memory_reconciliation_events(event_id,outbox_id,attempt_id,lease_fence,event_type,observed_artifact_digest,effect_digest,created_at)
      VALUES(?,?,?,?,?,?,?,?)`)
			.run(
				`reconcile:${id}:${fence}:${terminalDigest(digest)}`,
				id,
				String(latestMemoryOutboxAttempt(this.db, id).attempt_id),
				fence,
				eventType,
				digest,
				terminalDigest({ id, fence, digest }),
				at,
			);
		const next = digest === expected ? "settled" : "uncertain";
		this.db
			.prepare(
				"UPDATE memory_outbox SET state=?,settled_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? "
        + "WHERE outbox_id=? AND state='accepted_unsettled' AND lease_fence=?",
			)
			.run(next, next === "settled" ? at : null, at, id, fence);
		return this.output(row(this.db.prepare("SELECT * FROM memory_outbox WHERE outbox_id=?").get(id))!);
	}

	markUncertain(outboxId: string, fence: number, reason: string, now: string): MemoryOutboxRow {
		return this.output(markMemoryOutboxUncertain(this.db, outboxId, fence, reason, now));
	}

	bindRecoveredReceipt(
		outboxId: string,
		fence: number,
		receipt: MemoryWriteReceipt,
		now: string,
	): MemoryOutboxRow {
		const current = this.get(outboxId);
		if (current.state !== "accepted_unsettled" || current.lease_owner === null
			|| current.lease_fence !== fence || current.provider_artifact_digest !== null) {
			throw new TerminalMemoryError("MEMORY_OUTBOX_RECONCILIATION_REQUIRED");
		}
		const valid = validateMemoryWriteReceipt({ ...receipt, outcome: "accepted" });
		if (valid.outcome !== "accepted") {
			throw new TerminalMemoryError("MEMORY_PROVIDER_RECEIPT_INVALID");
		}
		bindMemoryProviderReceipt(this.db, {
			outbox_id: current.outbox_id,
			owner: current.lease_owner,
			fence,
			receipt: valid,
			at: timestamp(now),
			next: "accepted_unsettled",
			lease_expires_at: current.lease_expires_at,
		});
		return this.get(outboxId);
	}

	get(outboxId: string): MemoryOutboxRow {
		const found = row(this.db.prepare(
			"SELECT * FROM memory_outbox WHERE outbox_id=?",
		).get(identifier(outboxId)));
		if (!found) throw new TerminalMemoryError("MEMORY_OUTBOX_NOT_FOUND");
		return this.output(found);
	}

	private output(value: Record<string, unknown>): MemoryOutboxRow {
		return memoryOutboxRow(value);
	}
}
