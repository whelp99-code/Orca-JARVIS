import { type KeyObject } from "node:crypto";
import { JarvisError, deterministic, json, timestamp, type Row } from "./authority-db-base.js";
import { IngestAuthorityDb } from "./authority-ingest-store.js";
import { signPolicy, verifyDecisionReceipt } from "./receipt.js";
import type { ContinuationInput, DecisionReceipt, PolicyAuthorization } from "./types.js";

export abstract class PolicyAuthorityDb extends IngestAuthorityDb {
	protected work(workId: string): Row {
		const row = this.db
			.prepare(
				`SELECT w.*,s.digest AS snapshot_digest,p.id AS project_id FROM work_items w JOIN census_snapshots s
				ON s.id=w.snapshot_id JOIN projects p ON p.id=s.project_id WHERE w.id=?`,
			)
			.get(workId) as Row | undefined;
		if (!row) throw new JarvisError("WORK_NOT_FOUND");
		return row;
	}
	protected existing(workId: string): { continuation_id: string; intent_ids: string[] } | undefined {
		const continuation = this.db.prepare("SELECT id FROM continuation_acceptances WHERE work_id=?").get(workId) as
			| Row
			| undefined;
		if (!continuation) return undefined;
		return {
			continuation_id: String(continuation.id),
			intent_ids: (
				this.db.prepare("SELECT intent_id FROM outbox WHERE continuation_id=?").all(continuation.id) as Row[]
			)
				.map((row) => String(row.intent_id))
				.sort(),
		};
	}
	protected trusted(keyId: string, purpose: "decision" | "verifier" | "policy", principal?: string): string {
		const key = this.db
			.prepare(
				"SELECT k.* FROM trusted_authority_keys k JOIN authority_key_purposes p ON p.key_id=k.key_id WHERE k.key_id=? AND p.purpose=?",
			)
			.get(keyId, purpose) as Row | undefined;
		if (!key || key.algorithm !== "Ed25519" || (principal && key.principal_id !== principal))
			throw new JarvisError("UNTRUSTED_KEY");
		return String(key.public_key_pem);
	}
	revokeAuthority(reference: string, reason: string): void {
		this.atomic(() => {
			this.db
				.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
				.run(reference, reason, timestamp());
			const consumed = this.db
				.prepare("SELECT c.work_id FROM continuation_acceptances c WHERE c.authorization_id=?")
				.get(reference) as Row | undefined;
			this.audit("authority_revoked", reference, { reason });
			if (consumed) this.ledger(String(consumed.work_id), "STOP_REQUESTED", { reference, reason });
		});
	}
	protected revoked(reference: string): boolean {
		return Boolean(this.db.prepare("SELECT 1 FROM authority_revocations WHERE reference=?").get(reference));
	}
	protected policyFor(work: Row, keyId: string, key: KeyObject): PolicyAuthorization {
		const at = timestamp();
		return signPolicy(
			{
				schema_version: 1,
				authorization_id: deterministic("policy", String(work.proposal_hash)),
				proposal_hash: String(work.proposal_hash),
				key_id: keyId,
				algorithm: "Ed25519",
				project_id: String(work.project_id),
				repo_id: String(work.repo_id),
				worktree_id: String(work.worktree_id),
				terminal_kind: String(work.terminal_kind),
				terminal_session_id: String(work.terminal_session_id),
				census_run_id: String(work.census_run_id),
				census_item_id: String(work.census_item_id),
				snapshot_digest: String(work.snapshot_digest),
				attempt_id: String(work.attempt_id),
				action_digest: String(work.action_digest),
				scope_digest: String(work.scope_digest),
				forbidden_digest: String(work.forbidden_digest),
				policy_hash: String(work.policy_hash),
				budget_digest: String(work.budget_digest),
				deadline: String(work.deadline),
				lease_epoch: Number(work.lease_epoch),
				fencing_token: Number(work.fencing_token),
				issued_at: at,
				not_before: at,
				expires_at: new Date(Date.parse(at) + 15 * 60_000).toISOString(),
				nonce: deterministic("nonce", `${work.proposal_hash}:${at}`),
				max_uses: 1,
				status: "issued",
			},
			key,
		);
	}
	approveWithReceipt(workId: string, receipt: DecisionReceipt): { continuation_id: string; intent_ids: string[] } {
		const work = this.work(workId);
		const trusted = this.trusted(receipt.key_id, "decision", receipt.signer_principal_id);
		if (
			work.authorization !== "both" ||
			receipt.decision !== "approve" ||
			!verifyDecisionReceipt(receipt, trusted, new Date()) ||
			!this.matchReceipt(work, receipt)
		)
			throw new JarvisError("DECISION_RECEIPT_NOT_APPLICABLE");
		const existing = this.existing(workId);
		if (existing) {
			const stored = this.db
				.prepare(
					`SELECT r.payload_json FROM continuation_acceptances c JOIN decision_receipts r ON
					r.receipt_id=c.authorization_id WHERE c.work_id=? AND c.authorization_kind='receipt'`,
				)
				.get(workId) as Row | undefined;
			if (!stored || String(stored.payload_json) !== json(receipt)) throw new JarvisError("RECEIPT_REPLAY_MISMATCH");
			return existing;
		}
		return this.atomic(() => this.acceptInside(workId, { receipt }));
	}
	acceptContinuation(input: ContinuationInput): { continuation_id: string; intent_ids: string[] } {
		if (!input.receipt && !input.policy_authorization_id) throw new JarvisError("AUTHORIZATION_REQUIRED");
		throw new JarvisError("DIRECT_GUARD_API_RETIRED");
	}
}
