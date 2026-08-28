import { randomUUID, type KeyObject } from "node:crypto";
import { JarvisError, deterministic, json, sha, timestamp, type Row } from "./authority-db-base.js";
import { InitializationAuthorityDb } from "./authority-initialization-store.js";
import { verifyDecisionReceipt } from "./receipt.js";
import type { CensusSnapshot, DecisionReceipt, WorkState } from "./types.js";

export abstract class IngestAuthorityDb extends InitializationAuthorityDb {
	ingest(snapshot: CensusSnapshot, policyKey?: KeyObject): { digest: string; candidates: string[]; blocked: string[] } {
		if (snapshot.target_kind !== "codex" && snapshot.target_kind !== "claude")
			throw new JarvisError("UNSUPPORTED_TARGET");
		const observed = Date.parse(snapshot.observed_at);
		if (!Number.isFinite(observed) || observed > Date.now() || Date.now() - observed > 15 * 60_000)
			throw new JarvisError("STALE_CENSUS");
		const snapshotDigest = sha(snapshot);
		const candidates: string[] = [];
		const blocked: string[] = [];
		const created = timestamp();
		this.atomic(() => {
			this.db
				.prepare(
					"INSERT INTO projects(id,target_kind,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET target_kind=excluded.target_kind",
				)
				.run(snapshot.project_id, snapshot.target_kind, created);
			this.db
				.prepare(
					`INSERT INTO
					census_snapshots(id,project_id,version,digest,baseline,policy_hash,observed_at,payload_json)
					VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(digest) DO NOTHING`,
				)
				.run(
					randomUUID(),
					snapshot.project_id,
					snapshot.version,
					snapshotDigest,
					snapshot.baseline,
					snapshot.policy_hash,
					snapshot.observed_at,
					json(snapshot),
				);
			const snapshotRow = this.db.prepare("SELECT id FROM census_snapshots WHERE digest=?").get(snapshotDigest) as Row;
			for (const work of snapshot.work) {
				const valid =
					work.status === "open" &&
					work.kind === "code" &&
					["code", "human", "both"].includes(work.authorization) &&
					work.baseline === snapshot.baseline &&
					work.policy_hash === snapshot.policy_hash &&
					work.lease.valid !== false &&
					Date.parse(work.deadline) > Date.now();
				const state: WorkState = valid
					? work.authorization === "code"
						? "candidate"
						: "awaiting_decision"
					: "blocked";
				const byProposal = this.db
					.prepare("SELECT id,snapshot_id,state FROM work_items WHERE proposal_hash=?")
					.get(work.proposal_hash) as Row | undefined;
				const byId = this.db
					.prepare("SELECT id,proposal_hash,snapshot_id,state FROM work_items WHERE id=?")
					.get(work.id) as Row | undefined;
				if (byProposal || byId) {
					if (
						!byProposal ||
						!byId ||
						byProposal.id !== work.id ||
						byId.proposal_hash !== work.proposal_hash ||
						byProposal.snapshot_id !== snapshotRow.id
					)
						throw new JarvisError("CONFLICTING_CENSUS_PROPOSAL");
					if (byProposal.state === "candidate" || byProposal.state === "awaiting_decision") candidates.push(work.id);
					else if (byProposal.state === "blocked") blocked.push(work.id);
					continue;
				}
				this.db
					.prepare(
						`INSERT INTO
						work_items(id,snapshot_id,proposal_hash,target_kind,baseline,policy_hash,action,scope_json,
						forbidden_json,budget_json,attempt_id,deadline,lease_id,lease_epoch,fencing_token,state,created_at,
						authorization,repo_id,worktree_id,terminal_kind,terminal_session_id,census_run_id,census_item_id,
						action_digest,scope_digest,forbidden_digest,budget_digest,expected_effect,reversible,tokens_used)
						VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(proposal_hash) DO
						NOTHING`,
					)
					.run(
						work.id,
						snapshotRow.id,
						work.proposal_hash,
						snapshot.target_kind,
						work.baseline,
						work.policy_hash,
						work.action,
						json(work.scope),
						json(work.forbidden_actions),
						json(work.budget),
						work.attempt_id,
						work.deadline,
						work.lease.id,
						work.lease.epoch,
						work.lease.fencing_token,
						state,
						created,
						work.authorization,
						work.repo_id,
						work.worktree_id,
						work.terminal_kind,
						work.terminal_session_id,
						work.census_run_id,
						work.id,
						sha(work.action),
						sha(work.scope),
						sha(work.forbidden_actions),
						sha(work.budget),
						work.expected_effect,
						work.reversible ? 1 : 0,
						0,
					);
				this.ledger(work.id, "observed", { snapshot_digest: snapshotDigest });
				if (!valid) {
					this.ledger(work.id, "blocked", { reason: "invalid_census" });
					this.audit("census_blocked", work.id, { snapshot_digest: snapshotDigest });
					blocked.push(work.id);
				} else if (work.authorization === "code") {
					if (!policyKey) throw new JarvisError("POLICY_KEY_REQUIRED");
					this.ledger(work.id, "candidate", { proposal_hash: work.proposal_hash });
					this.ledger(work.id, "guard_passed", { snapshot_digest: snapshotDigest });
					this.audit("candidate", work.id, { authorization: "code" });
					this.acceptInside(work.id, { policy: this.policyFor(this.work(work.id), "local-policy-key", policyKey) });
				} else {
					this.ledger(work.id, "awaiting_decision", { authorization: work.authorization });
					this.audit("decision_card", work.id, { authorization: work.authorization });
					if (work.authorization === "both") candidates.push(work.id);
				}
				if (work.authorization !== "code") this.project(work.id, state);
			}
		});
		return { digest: snapshotDigest, candidates, blocked };
	}
	listApprovals(): Row[] {
		return (
			this.db
				.prepare(
					`SELECT
					w.id,w.proposal_hash,w.authorization,w.baseline,w.lease_id,w.lease_epoch,w.fencing_token,w.action,w.action_digest,w.scope_json
					AS allowed_scope,w.scope_digest,w.forbidden_json AS
					forbidden_actions,w.forbidden_digest,w.budget_json AS
					budget,w.budget_digest,w.policy_hash,w.attempt_id,w.deadline AS
					expiry,w.repo_id,w.worktree_id,w.terminal_kind,w.terminal_session_id,w.census_run_id,w.census_item_id,s.digest
					AS snapshot_digest,p.id AS project_id,w.expected_effect,w.reversible FROM work_items w JOIN
					census_snapshots s ON s.id=w.snapshot_id JOIN projects p ON p.id=s.project_id WHERE
					w.state='awaiting_decision' ORDER BY w.created_at`,
				)
				.all() as Row[]
		).map((row) => ({
			...row,
			allowed_scope: JSON.parse(String(row.allowed_scope)),
			forbidden_actions: JSON.parse(String(row.forbidden_actions)),
			budget: JSON.parse(String(row.budget)),
			reversible: Boolean(row.reversible),
		}));
	}
	rejectWithReceipt(workId: string, receipt: DecisionReceipt): void {
		this.atomic(() => {
			const work = this.work(workId);
			const trusted = this.trusted(receipt.key_id, "decision", receipt.signer_principal_id);
			if (
				work.authorization === "code" ||
				receipt.decision !== "reject" ||
				!verifyDecisionReceipt(receipt, trusted, new Date()) ||
				!this.matchReceipt(work, receipt)
			)
				throw new JarvisError("REJECTION_RECEIPT_INVALID");
			if (work.state === "rejected") {
				const stored = this.db
					.prepare("SELECT payload_json,key_id,signature FROM decision_records WHERE work_id=?")
					.get(workId) as Row | undefined;
				if (
					!stored ||
					stored.key_id !== receipt.key_id ||
					stored.signature !== receipt.signature ||
					stored.payload_json !== json(receipt)
				)
					throw new JarvisError("REJECTION_REPLAY_MISMATCH");
				return;
			}
			if (work.state !== "awaiting_decision") throw new JarvisError("DECISION_NOT_AVAILABLE");
			const changed = this.db
				.prepare("UPDATE work_items SET state='rejected' WHERE id=? AND state='awaiting_decision'")
				.run(workId);
			if (changed.changes !== 1) throw new JarvisError("DECISION_NOT_AVAILABLE");
			const recordId = deterministic("reject", String(work.proposal_hash));
			this.db
				.prepare(
					"INSERT INTO decision_records(record_id,work_id,proposal_hash,decision,payload_json,key_id,signature,created_at) VALUES(?,?,?,?,?,?,?,?)",
				)
				.run(
					recordId,
					workId,
					work.proposal_hash,
					"reject",
					json(receipt),
					receipt.key_id,
					receipt.signature,
					timestamp(),
				);
			this.ledger(workId, "rejected", { record_id: recordId });
			this.audit("rejected", workId, { record_id: recordId });
			this.project(workId, "rejected");
		});
	}
}
