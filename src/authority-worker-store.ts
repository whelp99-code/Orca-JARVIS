import { type Row } from "./authority-db-base.js";
import { VerificationAuthorityDb } from "./authority-verification-store.js";

export class AuthorityDb extends VerificationAuthorityDb {
	protected recoverAcknowledged(): number {
		return this.atomic(() => {
			const rows = this.db.prepare("SELECT id FROM work_items WHERE state='continued'").all() as Row[];
			let count = 0;
			for (const row of rows) if (this.promoteAcknowledgedInside(String(row.id))) count++;
			return count;
		});
	}
	protected currentIntent(intentId: string): Row | undefined {
		return this.db
			.prepare(
				`SELECT o.*,w.id AS work_id,w.deadline,w.attempt_id,w.lease_epoch AS current_epoch,w.fencing_token AS
				current_fence,w.state,w.tokens_used,w.budget_json,w.snapshot_id,w.action_digest,w.scope_digest,
				w.forbidden_digest,w.policy_hash,w.baseline,w.terminal_kind,w.terminal_session_id,c.lease_epoch
				AS accepted_epoch,c.fencing_token AS
				accepted_fence,c.authorization_id,c.baseline_digest,c.policy_hash_bound,c.action_digest_bound,
				c.scope_digest_bound,c.budget_digest_bound,c.authority_expires_at,c.idempotency_key
				AS continuation_idempotency FROM outbox o JOIN continuation_acceptances c ON c.id=o.continuation_id
				JOIN work_items w ON w.id=c.work_id WHERE o.intent_id=?`,
			)
			.get(intentId) as Row | undefined;
	}
	protected currentGuard(current: Row): boolean {
		const budget = JSON.parse(String(current.budget_json)) as { max_tokens: number };
		if (
			this.revoked(String(current.authorization_id)) ||
			current.state !== "continued" ||
			Date.parse(String(current.deadline)) <= Date.now() ||
			Date.parse(String(current.authority_expires_at)) <= Date.now() ||
			current.current_epoch !== current.accepted_epoch ||
			current.current_fence !== current.accepted_fence ||
			!Number.isFinite(Number(current.tokens_used)) ||
			Number(current.tokens_used) < 0 ||
			Number(current.tokens_used) > budget.max_tokens
		)
			return false;
		try {
			const payload = JSON.parse(String(current.payload_json)) as Record<string, unknown>;
			const target = payload.target as Record<string, unknown>;
			const proof = payload.guard_proof as Record<string, unknown>;
			return (
				(current.kind === "seed_mock" || current.kind === "dispatch_mock") &&
				payload.mock_kind === current.kind &&
				payload.continuation_id === current.continuation_id &&
				payload.operation_id === current.continuation_id &&
				payload.idempotency_key === current.intent_id &&
				target?.terminal_kind === current.terminal_kind &&
				target?.terminal_session_id === current.terminal_session_id &&
				payload.census_snapshot_hash ===
					(this.db.prepare("SELECT digest FROM census_snapshots WHERE id=?").get(current.snapshot_id) as Row).digest &&
				payload.action_hash === current.action_digest &&
				payload.authorization_reference === current.authorization_id &&
				payload.expiry === current.authority_expires_at &&
				proof?.baseline_digest === current.baseline_digest &&
				proof?.policy_hash === current.policy_hash_bound &&
				proof?.action_digest === current.action_digest_bound &&
				proof?.scope_digest === current.scope_digest_bound &&
				proof?.forbidden_digest === current.forbidden_digest &&
				proof?.budget_digest === current.budget_digest_bound &&
				proof?.attempt_id === current.attempt_id &&
				proof?.lease_epoch === current.accepted_epoch &&
				proof?.fencing_token === current.accepted_fence
			);
		} catch {
			return false;
		}
	}
	protected validateWholeSet(current: Row): boolean {
		const rows = this.db
			.prepare("SELECT intent_id,kind,acked_at,outcome FROM outbox WHERE continuation_id=? ORDER BY kind")
			.all(current.continuation_id) as Row[];
		if (
			rows.length !== 2 ||
			!rows.some((row) => row.kind === "seed_mock") ||
			!rows.some((row) => row.kind === "dispatch_mock") ||
			rows.some((row) => row.outcome !== null)
		)
			return false;
		return rows.every((row) => {
			const full = this.currentIntent(String(row.intent_id));
			return Boolean(full && this.currentGuard(full));
		});
	}
	protected blockCurrentInside(current: Row, outcome: "BLOCKED" | "UNKNOWN"): void {
		this.db
			.prepare("UPDATE outbox SET outcome=? WHERE continuation_id=? AND acked_at IS NULL AND outcome IS NULL")
			.run(outcome, current.continuation_id);
		this.db
			.prepare(
				"UPDATE work_items SET state='blocked' WHERE id=? AND state='continued' AND lease_epoch=? AND fencing_token=?",
			)
			.run(current.work_id, current.current_epoch, current.current_fence);
		this.ledger(String(current.work_id), "blocked", { outcome, intent_id: current.intent_id });
		this.audit("outbox_reconciled", String(current.intent_id), { outcome });
		this.project(String(current.work_id), "blocked");
	}
	protected blockOutbox(
		item: Row,
		outcome: "BLOCKED" | "UNKNOWN",
	): { processed: number; finalized: number; outcome: string } {
		this.atomic(() => {
			const current = this.currentIntent(String(item.intent_id));
			if (current) this.blockCurrentInside(current, outcome);
		});
		return { processed: 0, finalized: 0, outcome };
	}
	status(): Row {
		const rows = this.db.prepare("SELECT state,COUNT(*) AS count FROM work_projection GROUP BY state").all() as Row[];
		return {
			version: 1,
			states: rows,
			pending_outbox: (
				this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE acked_at IS NULL AND outcome IS NULL").get() as Row
			).count,
		};
	}
}
