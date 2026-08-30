import { ControlPlane, type ControlCommandRequestInput, type StoredControlCommand } from "./control-plane.js";
import { JarvisError, sha } from "./authority-db-base.js";
import { Recommendations } from "./recommendations.js";
import { projectRecommendations } from "./recommendation-projection.js";
import type { AuthorityDb } from "./authority-db.js";

export type RecommendationStageInput = Readonly<{
	recommendation_id: string;
	rank: number;
	requested_by: string;
	target: Readonly<Record<string, unknown>>;
	budget: Readonly<Record<string, unknown>>;
	deadline: string;
	now: string;
	request_id?: string;
}>;
export type RecommendationStageResult = Readonly<{
	request: StoredControlCommand;
	recommendation_id: string;
	rank: number;
	staged: true;
}>;

function nonempty(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new JarvisError("RECOMMENDATION_STAGE_INVALID");
	return value;
}
function object(value: unknown): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new JarvisError("RECOMMENDATION_STAGE_INVALID");
	return value as Readonly<Record<string, unknown>>;
}
function instant(value: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new JarvisError("RECOMMENDATION_STAGE_INVALID");
	return parsed;
}

export class RecommendationExecutor {
	private readonly control: ControlPlane;
	private readonly recommendations: Recommendations;
	constructor(private readonly authority: AuthorityDb) {
		this.control = new ControlPlane(authority);
		this.recommendations = new Recommendations(authority);
	}

	stage(input: RecommendationStageInput): RecommendationStageResult {
		const nowMs = instant(input.now);
		const deadlineMs = instant(input.deadline);
		const recommendationId = nonempty(input.recommendation_id);
		nonempty(input.requested_by);
		if (!Number.isSafeInteger(input.rank) || input.rank < 1 || input.rank > 32 || deadlineMs <= nowMs) throw new JarvisError("RECOMMENDATION_STAGE_INVALID");
		const projection = projectRecommendations(this.authority.db, input.now, 500);
		const action = projection.lifecycle_actions.find((candidate) => candidate.recommendation_id === recommendationId && candidate.rank === input.rank);
		if (action === undefined || action.state !== "pending" || !action.current || action.expires_at <= input.now)
			throw new JarvisError("RECOMMENDATION_NOT_EXECUTABLE");
		const requestId = input.request_id ?? `request:recommendation:${sha(`${recommendationId}:${input.rank}`).slice(7)}`;
		const expiresAt = new Date(Math.min(deadlineMs, Date.parse(action.expires_at))).toISOString();
		if (Date.parse(expiresAt) <= nowMs) throw new JarvisError("RECOMMENDATION_NOT_EXECUTABLE");
		const target = object(input.target);
		const budget = object(input.budget);
		const command: ControlCommandRequestInput = {
			schema_version: 1,
			request_id: requestId,
			action: "workflow.start",
			action_level: 2,
			target: {
				...target,
				recommendation_id: recommendationId,
				recommendation_rank: input.rank,
				context_digest: action.context_digest,
				evidence_digest: action.evidence_digest,
			},
			args: {
				recommendation_id: recommendationId,
				recommendation_rank: input.rank,
				context_digest: action.context_digest,
				evidence_digest: action.evidence_digest,
				target,
				budget,
				deadline: expiresAt,
			},
			reversible: true,
			requested_by: input.requested_by,
			requested_at: input.now,
			expires_at: expiresAt,
			nonce: sha(`${requestId}:${action.identity_digest}`).slice(7),
		};
		const request = this.control.stage(command, new Date(nowMs));
		this.recommendations.transition({
			recommendation_id: recommendationId,
			rank: input.rank,
			state: "accepted",
			evidence_digest: action.evidence_digest,
			occurred_at: input.now,
		});
		return {
			request,
			recommendation_id: recommendationId,
			rank: input.rank,
			staged: true,
		};
	}
}

export function stageApprovedRecommendation(authority: AuthorityDb, input: RecommendationStageInput): RecommendationStageResult {
	return new RecommendationExecutor(authority).stage(input);
}
