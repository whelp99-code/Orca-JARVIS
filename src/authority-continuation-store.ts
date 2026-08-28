import { JarvisError, deterministic, json, sha, timestamp, type Credential } from "./authority-db-base.js";
import { PolicyAuthorityDb } from "./authority-policy-store.js";
import { verifyDecisionReceipt, verifyPolicyAuthorization } from "./receipt.js";

export abstract class ContinuationAuthorityDb extends PolicyAuthorityDb {
	protected acceptInside(workId: string, credential: Credential): { continuation_id: string; intent_ids: string[] } {
		const work = this.work(workId);
		const at = new Date();
		const expectedState =
			work.authorization === "both" ? "awaiting_decision" : work.authorization === "code" ? "candidate" : "";
		if (!expectedState || work.state !== expectedState || !this.censusGuardsCurrent(work, at))
			throw new JarvisError("GUARD_STATE_INVALID");
		let reference: string;
		let kind: string;
		let credentialExpires: string;
		if (credential.receipt) {
			const receipt = credential.receipt;
			const trusted = this.trusted(receipt.key_id, "decision", receipt.signer_principal_id);
			if (
				this.revoked(receipt.receipt_id) ||
				work.authorization !== "both" ||
				receipt.decision !== "approve" ||
				!verifyDecisionReceipt(receipt, trusted, at) ||
				!this.matchReceipt(work, receipt)
			)
				throw new JarvisError("RECEIPT_INVALID");
			this.db
				.prepare(
					"INSERT INTO decision_receipts(receipt_id,proposal_hash,payload_json,public_key,signature,expires_at,max_uses,created_at) VALUES(?,?,?,?,?,?,?,?)",
				)
				.run(
					receipt.receipt_id,
					receipt.proposal_hash,
					json(receipt),
					trusted,
					receipt.signature,
					receipt.expires_at,
					1,
					timestamp(),
				);
			reference = receipt.receipt_id;
			credentialExpires = receipt.expires_at;
			kind = "receipt";
		} else {
			const policy = credential.policy;
			if (!policy) throw new JarvisError("AUTHORIZATION_REQUIRED");
			const trusted = this.trusted(policy.key_id, "policy", "shadow-policy");
			if (
				this.revoked(policy.authorization_id) ||
				work.authorization !== "code" ||
				!verifyPolicyAuthorization(policy, trusted, at) ||
				!this.matchPolicy(work, policy)
			)
				throw new JarvisError("POLICY_AUTHORIZATION_INVALID");
			this.db
				.prepare(
					`INSERT INTO
					policy_authorizations(id,proposal_hash,policy_hash,action,expires_at,used_at,created_at,key_id,payload_json,signature)
					VALUES(?,?,?,?,?,?,?,?,?,?)`,
				)
				.run(
					policy.authorization_id,
					policy.proposal_hash,
					policy.policy_hash,
					work.action,
					policy.expires_at,
					null,
					timestamp(),
					policy.key_id,
					json(policy),
					policy.signature,
				);
			reference = policy.authorization_id;
			credentialExpires = policy.expires_at;
			kind = "policy";
		}
		const authorityExpires = new Date(
			Math.min(Date.parse(String(work.deadline)), Date.parse(credentialExpires)),
		).toISOString();
		if (Date.parse(authorityExpires) <= at.getTime()) throw new JarvisError("AUTHORITY_EXPIRED");
		const transitioned = this.db
			.prepare(
				"UPDATE work_items SET state='continued' WHERE id=? AND state=? AND lease_epoch=? AND fencing_token=? AND deadline>?",
			)
			.run(work.id, expectedState, work.lease_epoch, work.fencing_token, timestamp());
		if (transitioned.changes !== 1) throw new JarvisError("GUARD_STATE_INVALID");
		const continuationId = deterministic("continuation", String(work.proposal_hash));
		this.db
			.prepare(
				`INSERT INTO
				continuation_acceptances(id,work_id,proposal_hash,authorization_kind,authorization_id,lease_epoch,
				fencing_token,created_at,baseline_digest,policy_hash_bound,action_digest_bound,scope_digest_bound,
				budget_digest_bound,authority_expires_at,idempotency_key,status)
				VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			)
			.run(
				continuationId,
				work.id,
				work.proposal_hash,
				kind,
				reference,
				work.lease_epoch,
				work.fencing_token,
				timestamp(),
				sha(String(work.baseline)),
				work.policy_hash,
				work.action_digest,
				work.scope_digest,
				work.budget_digest,
				authorityExpires,
				deterministic("idempotency", String(work.proposal_hash)),
				"accepted",
			);
		if (kind === "receipt")
			this.db
				.prepare("INSERT INTO receipt_redemptions(receipt_id,continuation_id,redeemed_at) VALUES(?,?,?)")
				.run(reference, continuationId, timestamp());
		else
			this.db
				.prepare("INSERT INTO policy_redemptions(authorization_id,continuation_id,redeemed_at) VALUES(?,?,?)")
				.run(reference, continuationId, timestamp());
		const intentIds: string[] = [];
		const dispatchPayload = {
			operation_id: continuationId,
			target: { terminal_kind: work.terminal_kind, terminal_session_id: work.terminal_session_id },
			census_snapshot_hash: work.snapshot_digest,
			action_hash: work.action_digest,
			authorization_reference: reference,
			expiry: authorityExpires,
			continuation_id: continuationId,
			lease_epoch: work.lease_epoch,
			fencing_token: work.fencing_token,
		};
		// Once connected, the coordinator intent is durable before any legacy mock
		// consumer may acknowledge the continuation.  Compatibility mocks remain
		// present, but cannot become an early success acknowledgement.
		if (this.gjcOperational()) {
			const config = this.gjcConfig();
			if (!config) throw new JarvisError("GJC_NOT_CONNECTED");
			this.createGjcIntent(
				"dispatch",
				{ ...dispatchPayload, cwd: config.canonical_cwd, session_id: config.session_id },
				deterministic("gjc-dispatch", continuationId),
				continuationId,
			);
		}
		for (const mockKind of ["seed_mock", "dispatch_mock"]) {
			const id = deterministic("intent", `${continuationId}:${mockKind}`);
			intentIds.push(id);
			const payload = {
				...dispatchPayload,
				idempotency_key: id,
				guard_proof: {
					baseline_digest: sha(String(work.baseline)),
					policy_hash: work.policy_hash,
					action_digest: work.action_digest,
					scope_digest: work.scope_digest,
					forbidden_digest: work.forbidden_digest,
					budget_digest: work.budget_digest,
					attempt_id: work.attempt_id,
					lease_epoch: work.lease_epoch,
					fencing_token: work.fencing_token,
				},
				mock_kind: mockKind,
				shadow: true,
			};
			this.db
				.prepare("INSERT INTO outbox(intent_id,continuation_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)")
				.run(id, continuationId, mockKind, json(payload), timestamp());
		}
		this.ledger(String(work.id), "continued", { continuation_id: continuationId, authorization: reference });
		this.audit("continuation_accepted", continuationId, { work_id: work.id, reference });
		this.project(String(work.id), "continued");
		return { continuation_id: continuationId, intent_ids: intentIds.sort() };
	}
}
