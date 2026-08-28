import { JarvisError, progressFaultPoints, timestamp, type ProgressFaultPoint, type Row } from "./authority-db-base.js";
import { GjcQuestionAuthorityDb } from "./gjc-question-store.js";
import type {
	ContextPersistenceInput,
	RecommendationActionTransition,
	RecommendationPersistenceInput,
	ReconstructedRecommendation,
	StoredContext,
	StoredObservation,
	StoredRecommendation,
} from "./personal-context-persistence.js";
import { parseProgressBatch, serializeProgressReport } from "./progress.js";
import type {
	OrcaObservationSource,
	ProgressBatch,
	ProgressTransitionEvidence,
	StoredProgressReport,
} from "./types.js";

export abstract class ProgressAuthorityDb extends GjcQuestionAuthorityDb {
	persistObservation(value: unknown, now = timestamp()): StoredObservation {
		return this.personalContext.persistObservation(value, now);
	}
	persistContextSnapshot(value: ContextPersistenceInput, now = timestamp()): StoredContext {
		return this.personalContext.persistContext(value, now);
	}
	persistRecommendation(value: RecommendationPersistenceInput, now = timestamp()): StoredRecommendation {
		return this.personalContext.persistRecommendation(value, now);
	}
	transitionRecommendationAction(input: RecommendationActionTransition): void {
		this.personalContext.transitionAction(input);
	}
	getPersonalRecommendation(
		id: RecommendationActionTransition["recommendation_id"],
	): ReconstructedRecommendation | undefined {
		return this.personalContext.getRecommendation(id);
	}
	getOrcaObservationSource(worktree: string, terminalHandle: string): OrcaObservationSource | undefined {
		return this.orcaObservations.getSource(worktree, terminalHandle);
	}
	protected progressFault(point: ProgressFaultPoint): void {
		if (!progressFaultPoints.has(point)) throw new JarvisError("PROGRESS_INPUT_INVALID");
		this.progressTestHook?.(point);
		if (this.progressFaultPoint === point) throw new JarvisError("SIMULATED_PROGRESS_CRASH");
	}
	protected progressReport(row: Row): StoredProgressReport {
		return {
			sequence: Number(row.sequence),
			report_id: String(row.report_id),
			worktree: String(row.worktree_selector),
			payload_json: String(row.payload_json),
			payload_digest: String(row.payload_digest),
			created_at: String(row.created_at),
		};
	}
	stageProgressBatch(input: ProgressBatch): { report: StoredProgressReport | null } {
		const batch = parseProgressBatch(input);
		try {
			const result = this.atomic(() => {
				const pending = this.db
					.prepare(
						`SELECT o.sequence,o.report_id,o.worktree_selector,o.payload_json,o.payload_digest,o.created_at FROM
						progress_report_outbox o LEFT JOIN progress_delivery_receipts r ON r.report_id=o.report_id WHERE
						r.report_id IS NULL ORDER BY o.sequence LIMIT 1`,
					)
					.get() as Row | undefined;
				if (pending) throw new JarvisError("PROGRESS_PENDING_REPORT");
				const planned: Array<{
					assessment: ProgressBatch["assessments"][number];
					assessmentJson: string;
					projection: Row | undefined;
					transition: ProgressTransitionEvidence | undefined;
				}> = [];
				for (const assessment of [...batch.assessments].sort((left, right) =>
					left.terminal_id < right.terminal_id ? -1 : left.terminal_id > right.terminal_id ? 1 : 0,
				)) {
					const assessmentJson = JSON.stringify({
						provider: assessment.provider,
						terminal_id: assessment.terminal_id,
						incarnation_id: assessment.incarnation_id,
						cursor: assessment.cursor,
						observation_identity: assessment.observation_identity,
						state: assessment.state,
						worktree: batch.worktree,
						observed_at: batch.observed_at,
					});
					const observation = this.db
						.prepare("SELECT assessment_json FROM progress_observations WHERE observation_identity=?")
						.get(assessment.observation_identity) as Row | undefined;
					if (observation) {
						if (String(observation.assessment_json) !== assessmentJson)
							throw new JarvisError("PROGRESS_OBSERVATION_CONFLICT");
						continue;
					}
					const binding = this.db
						.prepare(
							"SELECT provider FROM progress_observations WHERE worktree_selector=? AND terminal_handle=? AND incarnation_id=? LIMIT 1",
						)
						.get(batch.worktree, assessment.terminal_id, assessment.incarnation_id) as Row | undefined;
					if (binding && binding.provider !== assessment.provider) throw new JarvisError("PROGRESS_BINDING_CONFLICT");
					const projection = this.db
						.prepare(
							"SELECT provider,incarnation_id,state,observed_at FROM progress_projection WHERE worktree_selector=? AND terminal_handle=?",
						)
						.get(batch.worktree, assessment.terminal_id) as Row | undefined;
					if (projection && batch.observed_at <= String(projection.observed_at))
						throw new JarvisError("PROGRESS_STALE_ASSESSMENT");
					this.progressFault("before_observation_insert");
					this.db
						.prepare(
							`INSERT INTO
							progress_observations(observation_identity,worktree_selector,terminal_handle,incarnation_id,provider,observed_at,assessment_json,created_at)
							VALUES(?,?,?,?,?,?,?,?)`,
						)
						.run(
							assessment.observation_identity,
							batch.worktree,
							assessment.terminal_id,
							assessment.incarnation_id,
							assessment.provider,
							batch.observed_at,
							assessmentJson,
							batch.observed_at,
						);
					this.progressFault("after_observation_insert");
					const from =
						projection && projection.incarnation_id === assessment.incarnation_id
							? (String(projection.state) as ProgressTransitionEvidence["from"])
							: null;
					planned.push({
						assessment,
						assessmentJson,
						projection,
						transition:
							from === assessment.state
								? undefined
								: {
										provider: assessment.provider,
										terminal_id: assessment.terminal_id,
										incarnation_id: assessment.incarnation_id,
										cursor: assessment.cursor,
										from,
										to: assessment.state,
										observation_identity: assessment.observation_identity,
									},
					});
				}
				const transitions = planned
					.flatMap((item) => (item.transition ? [item.transition] : []))
					.sort((left, right) =>
						left.provider < right.provider
							? -1
							: left.provider > right.provider
								? 1
								: left.terminal_id < right.terminal_id
									? -1
									: left.terminal_id > right.terminal_id
										? 1
										: left.incarnation_id < right.incarnation_id
											? -1
											: left.incarnation_id > right.incarnation_id
												? 1
												: 0,
					);
				const report =
					transitions.length === 0 ? null : serializeProgressReport(batch.worktree, batch.observed_at, transitions);
				if (report && this.db.prepare("SELECT 1 FROM progress_report_outbox WHERE report_id=?").get(report.report_id))
					throw new JarvisError("PROGRESS_REPORT_ID_CONFLICT");
				for (const item of planned)
					this.db
						.prepare(
							`INSERT INTO
							progress_projection(worktree_selector,terminal_handle,provider,incarnation_id,state,cursor,observation_identity,observed_at,updated_at)
							VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(worktree_selector,terminal_handle) DO UPDATE SET
							provider=excluded.provider,incarnation_id=excluded.incarnation_id,state=excluded.state,
							cursor=excluded.cursor,observation_identity=excluded.observation_identity,
							observed_at=excluded.observed_at,updated_at=excluded.updated_at`,
						)
						.run(
							batch.worktree,
							item.assessment.terminal_id,
							item.assessment.provider,
							item.assessment.incarnation_id,
							item.assessment.state,
							item.assessment.cursor,
							item.assessment.observation_identity,
							batch.observed_at,
							batch.observed_at,
						);
				if (planned.length > 0) this.progressFault("after_projection_upsert");
				if (!report) return { report: null };
				this.db
					.prepare(
						"INSERT INTO progress_report_outbox(report_id,worktree_selector,payload_json,payload_digest,created_at) VALUES(?,?,?,?,?)",
					)
					.run(report.report_id, batch.worktree, report.payload_json, report.payload_digest, batch.observed_at);
				this.progressFault("after_outbox_insert_before_commit");
				const stored = this.db
					.prepare(
						"SELECT sequence,report_id,worktree_selector,payload_json,payload_digest,created_at FROM progress_report_outbox WHERE report_id=?",
					)
					.get(report.report_id) as Row;
				return { report: this.progressReport(stored) };
			});
			this.progressFault("after_stage_commit");
			return result;
		} catch (error) {
			if (error instanceof JarvisError) throw error;
			throw new JarvisError("PROGRESS_STORAGE_FAILED");
		}
	}
}
