import { ContinuationAuthorityDb } from "./authority-continuation-store.js";
import { same, type Row } from "./authority-db-base.js";
import type { CensusSnapshot, DecisionReceipt, PolicyAuthorization } from "./types.js";

export abstract class GuardAuthorityDb extends ContinuationAuthorityDb {
	protected censusGuardsCurrent(work: Row, at: Date): boolean {
		const source = this.db
			.prepare("SELECT payload_json,baseline,policy_hash,digest,observed_at FROM census_snapshots WHERE id=?")
			.get(work.snapshot_id) as Row | undefined;
		const budget = JSON.parse(String(work.budget_json)) as { max_tokens: number };
		const observed = Date.parse(String(source?.observed_at));
		if (
			!source ||
			!Number.isFinite(observed) ||
			observed > at.getTime() ||
			at.getTime() - observed > 15 * 60_000 ||
			source.digest !== work.snapshot_digest ||
			source.baseline !== work.baseline ||
			source.policy_hash !== work.policy_hash ||
			Date.parse(String(work.deadline)) <= at.getTime() ||
			Number(work.lease_epoch) < 1 ||
			Number(work.fencing_token) < 1 ||
			!Number.isFinite(Number(work.tokens_used)) ||
			Number(work.tokens_used) < 0 ||
			Number(work.tokens_used) > budget.max_tokens ||
			budget.max_tokens <= 0
		)
			return false;
		const snapshot = JSON.parse(String(source.payload_json)) as CensusSnapshot;
		const census = snapshot.work.find((item) => item.id === work.id && item.proposal_hash === work.proposal_hash);
		return (
			!!census &&
			census.status === "open" &&
			census.kind === "code" &&
			census.authorization === work.authorization &&
			census.baseline === work.baseline &&
			census.policy_hash === work.policy_hash &&
			census.expected_effect === work.expected_effect &&
			Number(census.reversible) === Number(work.reversible) &&
			same(census.scope, JSON.parse(String(work.scope_json))) &&
			same(census.forbidden_actions, JSON.parse(String(work.forbidden_json))) &&
			same(census.budget, budget) &&
			census.attempt_id === work.attempt_id &&
			census.deadline === work.deadline &&
			census.lease.id === work.lease_id &&
			census.lease.epoch === work.lease_epoch &&
			census.lease.fencing_token === work.fencing_token &&
			census.lease.valid !== false
		);
	}
	protected matchReceipt(work: Row, receipt: DecisionReceipt): boolean {
		return (
			receipt.proposal_hash === work.proposal_hash &&
			receipt.project_id === work.project_id &&
			receipt.repo_id === work.repo_id &&
			receipt.worktree_id === work.worktree_id &&
			receipt.terminal_kind === work.terminal_kind &&
			receipt.terminal_session_id === work.terminal_session_id &&
			receipt.census_run_id === work.census_run_id &&
			receipt.census_item_id === work.census_item_id &&
			receipt.snapshot_digest === work.snapshot_digest &&
			receipt.attempt_id === work.attempt_id &&
			receipt.action_digest === work.action_digest &&
			receipt.scope_digest === work.scope_digest &&
			same(receipt.forbidden_actions, JSON.parse(String(work.forbidden_json))) &&
			receipt.forbidden_digest === work.forbidden_digest &&
			receipt.policy_hash === work.policy_hash &&
			receipt.budget_digest === work.budget_digest &&
			receipt.expected_effect === work.expected_effect &&
			Number(receipt.reversible) === Number(work.reversible)
		);
	}
	protected matchPolicy(work: Row, policy: PolicyAuthorization): boolean {
		return (
			policy.proposal_hash === work.proposal_hash &&
			policy.project_id === work.project_id &&
			policy.repo_id === work.repo_id &&
			policy.worktree_id === work.worktree_id &&
			policy.terminal_kind === work.terminal_kind &&
			policy.terminal_session_id === work.terminal_session_id &&
			policy.census_run_id === work.census_run_id &&
			policy.census_item_id === work.census_item_id &&
			policy.snapshot_digest === work.snapshot_digest &&
			policy.attempt_id === work.attempt_id &&
			policy.action_digest === work.action_digest &&
			policy.scope_digest === work.scope_digest &&
			policy.forbidden_digest === work.forbidden_digest &&
			policy.policy_hash === work.policy_hash &&
			policy.budget_digest === work.budget_digest &&
			policy.deadline === work.deadline &&
			policy.lease_epoch === work.lease_epoch &&
			policy.fencing_token === work.fencing_token
		);
	}
}
