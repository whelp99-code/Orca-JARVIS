import { JarvisError, json, same, sha, timestamp, type Row } from "./authority-db-base.js";
import { GuardAuthorityDb } from "./authority-guard-store.js";
import { verifyVerificationEvidence } from "./receipt.js";
import type { CensusSnapshot, VerificationEvidence, WorkState } from "./types.js";

export abstract class VerificationAuthorityDb extends GuardAuthorityDb {
	recordVerification(evidence: VerificationEvidence): void {
		this.atomic(() => {
			const work = this.work(evidence.work_id);
			const trusted = this.trusted(evidence.signer_key_id, "verifier", "independent-verifier");
			const source = this.db
				.prepare("SELECT payload_json FROM census_snapshots WHERE id=?")
				.get(work.snapshot_id) as Row;
			const census = JSON.parse(String(source.payload_json)) as CensusSnapshot;
			const item = census.work.find(
				(candidate) => candidate.id === work.id && candidate.proposal_hash === work.proposal_hash,
			);
			const allowed = item?.verify_allowlist.some(
				(command) =>
					same(command.argv, evidence.argv) &&
					command.cwd === evidence.cwd &&
					command.expected_exit === evidence.expected_exit,
			);
			if (
				work.state !== "awaiting_verification" ||
				!allowed ||
				!verifyVerificationEvidence(evidence, trusted) ||
				evidence.attempt_id !== work.attempt_id ||
				evidence.snapshot_digest !== work.snapshot_digest ||
				evidence.action_digest !== work.action_digest ||
				evidence.policy_hash !== work.policy_hash ||
				evidence.scope_digest !== work.scope_digest ||
				evidence.lease_epoch !== work.lease_epoch ||
				evidence.fencing_token !== work.fencing_token
			)
				throw new JarvisError("VERIFICATION_EVIDENCE_INVALID");
			this.db
				.prepare(
					"INSERT INTO verification_evidence(evidence_id,work_id,payload_json,signer_key_id,signature,created_at) VALUES(?,?,?,?,?,?)",
				)
				.run(evidence.evidence_id, work.id, json(evidence), evidence.signer_key_id, evidence.signature, timestamp());
			this.ledger(String(work.id), "verification_recorded", { evidence_id: evidence.evidence_id });
			this.audit("verification_recorded", evidence.evidence_id, { work_id: work.id });
			this.tryFinalizeInside(work);
		});
	}
	recordResolution(workId: string, followup: CensusSnapshot): void {
		this.atomic(() => {
			const work = this.work(workId);
			const source = this.db
				.prepare("SELECT observed_at FROM census_snapshots WHERE id=?")
				.get(work.snapshot_id) as Row;
			const followupDigest = sha(followup);
			const absent = !followup.work.some((item) => item.id === work.id || item.proposal_hash === work.proposal_hash);
			if (
				work.state !== "awaiting_verification" ||
				followup.project_id !== work.project_id ||
				followup.target_kind !== work.target_kind ||
				!absent ||
				Date.parse(followup.observed_at) <= Date.parse(String(source.observed_at))
			)
				throw new JarvisError("RESOLUTION_CENSUS_INVALID");
			this.db
				.prepare(
					"INSERT INTO resolution_census(work_id,followup_digest,observed_at,payload_json,created_at) VALUES(?,?,?,?,?)",
				)
				.run(work.id, followupDigest, followup.observed_at, json(followup), timestamp());
			this.ledger(String(work.id), "resolution_recorded", { followup_digest: followupDigest });
			this.audit("resolution_recorded", String(work.id), { followup_digest: followupDigest });
			this.tryFinalizeInside(work);
		});
	}
	protected promoteAcknowledgedInside(workId: string): boolean {
		const work = this.work(workId);
		const continuation = this.db.prepare("SELECT * FROM continuation_acceptances WHERE work_id=?").get(workId) as
			| Row
			| undefined;
		const budget = JSON.parse(String(work.budget_json)) as { max_tokens: number };
		if (
			!continuation ||
			work.state !== "continued" ||
			Date.parse(String(work.deadline)) <= Date.now() ||
			work.lease_epoch !== continuation.lease_epoch ||
			work.fencing_token !== continuation.fencing_token ||
			Number(work.tokens_used) < 0 ||
			Number(work.tokens_used) > budget.max_tokens
		)
			return false;
		const intents = this.db
			.prepare("SELECT kind,acked_at,outcome FROM outbox WHERE continuation_id=? ORDER BY kind")
			.all(continuation.id) as Row[];
		if (
			intents.length !== 2 ||
			!intents.some((row) => row.kind === "seed_mock") ||
			!intents.some((row) => row.kind === "dispatch_mock")
		) {
			this.db.prepare("UPDATE work_items SET state='blocked' WHERE id=? AND state='continued'").run(workId);
			this.ledger(workId, "blocked", { reason: "outbox_completeness" });
			this.audit("outbox_completeness", workId, {});
			this.project(workId, "blocked");
			return false;
		}
		if (intents.some((row) => !row.acked_at || row.outcome !== null)) return false;
		const changed = this.db
			.prepare(
				"UPDATE work_items SET state='awaiting_verification' WHERE id=? AND state='continued' AND lease_epoch=? AND fencing_token=?",
			)
			.run(workId, continuation.lease_epoch, continuation.fencing_token);
		if (changed.changes !== 1) return false;
		this.ledger(workId, "awaiting_verification", { continuation_id: continuation.id });
		this.audit("awaiting_verification", workId, {});
		this.project(workId, "awaiting_verification" as WorkState);
		return true;
	}
	protected tryFinalizeInside(work: Row): boolean {
		const evidence = this.db.prepare("SELECT 1 FROM verification_evidence WHERE work_id=?").get(work.id);
		const resolution = this.db.prepare("SELECT 1 FROM resolution_census WHERE work_id=?").get(work.id);
		const continuation = this.db.prepare("SELECT * FROM continuation_acceptances WHERE work_id=?").get(work.id) as
			| Row
			| undefined;
		if (
			!evidence ||
			!resolution ||
			!continuation ||
			work.state !== "awaiting_verification" ||
			work.lease_epoch !== continuation.lease_epoch ||
			work.fencing_token !== continuation.fencing_token
		)
			return false;
		const changed = this.db
			.prepare(
				"UPDATE work_items SET state='shadow_completed' WHERE id=? AND state='awaiting_verification' AND lease_epoch=? AND fencing_token=?",
			)
			.run(work.id, continuation.lease_epoch, continuation.fencing_token);
		if (changed.changes !== 1) return false;
		this.db
			.prepare("UPDATE outbox SET finalized_at=? WHERE continuation_id=? AND finalized_at IS NULL")
			.run(timestamp(), continuation.id);
		this.ledger(String(work.id), "shadow_completed", { continuation_id: continuation.id });
		this.audit("shadow_completed", String(work.id), {});
		this.project(String(work.id), "shadow_completed");
		return true;
	}
	workerOnce(crashAt?: "before_commit" | "after_commit" | "ambiguous"): {
		processed: number;
		finalized: number;
		outcome?: string;
	} {
		const recovered = this.recoverAcknowledged();
		const item = this.db
			.prepare(
				"SELECT intent_id,continuation_id FROM outbox WHERE acked_at IS NULL AND outcome IS NULL ORDER BY created_at,intent_id LIMIT 1",
			)
			.get() as Row | undefined;
		if (!item) return { processed: 0, finalized: 0 };
		const gjc = this.db
			.prepare(
				"SELECT state FROM gjc_intents WHERE continuation_id=? AND kind='dispatch' ORDER BY created_at DESC LIMIT 1",
			)
			.get(item.continuation_id) as Row | undefined;
		const reconciled = this.db
			.prepare("SELECT 1 FROM gjc_intents WHERE continuation_id=? AND kind='sync' AND state='completed' LIMIT 1")
			.get(item.continuation_id);
		if (gjc) {
			if (gjc.state === "failed") return this.blockOutbox(item, "BLOCKED");
			if (gjc.state !== "completed" && !reconciled) return { processed: 0, finalized: 0, outcome: "GJC_PENDING" };
		}
		if (crashAt === "before_commit") throw new JarvisError("SIMULATED_CRASH_BEFORE_COMMIT");
		if (crashAt === "ambiguous") return this.blockOutbox(item, "UNKNOWN");
		this.beforeAckHook?.();
		let acked = false;
		let blocked = false;
		this.atomic(() => {
			const current = this.currentIntent(String(item.intent_id));
			if (!current || !this.validateWholeSet(current)) {
				if (current) this.blockCurrentInside(current, "BLOCKED");
				blocked = true;
				return;
			}
			this.db
				.prepare("INSERT INTO consumer_inbox(intent_id,consumed_at) VALUES(?,?) ON CONFLICT(intent_id) DO NOTHING")
				.run(item.intent_id, timestamp());
			const changed = this.db
				.prepare(
					"UPDATE outbox SET attempts=attempts+1,delivered_at=COALESCE(delivered_at,?),acked_at=? WHERE intent_id=? AND acked_at IS NULL AND outcome IS NULL",
				)
				.run(timestamp(), timestamp(), item.intent_id);
			if (changed.changes !== 1) throw new JarvisError("OUTBOX_CLAIM_CONFLICT");
			this.audit("mock_ack", String(item.intent_id), { continuation_id: item.continuation_id });
			acked = true;
		});
		if (blocked) return { processed: 0, finalized: 0, outcome: "BLOCKED" };
		if (crashAt === "after_commit") throw new JarvisError("SIMULATED_CRASH_AFTER_COMMIT");
		this.atomic(() => {
			const current = this.currentIntent(String(item.intent_id));
			if (!current || !this.currentGuard(current)) {
				if (current) this.blockCurrentInside(current, "BLOCKED");
				return;
			}
			this.promoteAcknowledgedInside(String(current.work_id));
		});
		return { processed: acked ? 1 : 0, finalized: 0, ...(recovered ? { outcome: "AWAITING_VERIFICATION" } : {}) };
	}
}
