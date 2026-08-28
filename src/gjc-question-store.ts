import { JarvisError, json, sha, timestamp, type Row } from "./authority-db-base.js";
import { GjcIntentAuthorityDb } from "./gjc-intent-store.js";

export abstract class GjcQuestionAuthorityDb extends GjcIntentAuthorityDb {
	bindGjcQuestion(intentId: string, questionId: string, snapshot: unknown, now = timestamp()): void {
		const snapshot_json = json(snapshot);
		const snapshot_digest = sha(snapshot_json);
		this.atomic(() => {
			const prior = this.db
				.prepare("SELECT intent_id,snapshot_digest FROM gjc_questions WHERE question_id=?")
				.get(questionId) as Row | undefined;
			if (prior) {
				if (prior.intent_id !== intentId || prior.snapshot_digest !== snapshot_digest)
					throw new JarvisError("GJC_QUESTION_BINDING_CONFLICT");
				return;
			}
			this.db
				.prepare(
					"INSERT INTO gjc_questions(question_id,intent_id,snapshot_json,snapshot_digest,state,created_at) VALUES(?,?,?,?,?,?)",
				)
				.run(questionId, intentId, snapshot_json, snapshot_digest, "open", now);
		});
	}
	createGjcQuestionAnswerIntent(
		questionId: string,
		input: Record<string, unknown>,
		idempotencyKey: string,
		now = timestamp(),
	): string {
		const config = this.gjcConfig();
		if (!config?.operational || !idempotencyKey) throw new JarvisError("GJC_ANSWER_NOT_AUTHORIZED");
		const keys = Object.keys(input).sort();
		if (
			keys.join(",") !== "answer,answer_binding,session_id,turn_id" ||
			input.session_id !== config.session_id ||
			typeof input.turn_id !== "string" ||
			!input.turn_id ||
			typeof input.answer_binding !== "object" ||
			input.answer_binding === null ||
			Array.isArray(input.answer_binding)
		)
			throw new JarvisError("GJC_ANSWER_SCHEMA_INVALID");
		const question = this.db
			.prepare("SELECT snapshot_json,state FROM gjc_questions WHERE question_id=?")
			.get(questionId) as Row | undefined;
		if (!question || question.state !== "open") throw new JarvisError("GJC_QUESTION_NOT_OPEN");
		let snapshot: Record<string, unknown>;
		try {
			snapshot = JSON.parse(String(question.snapshot_json)) as Record<string, unknown>;
		} catch {
			throw new JarvisError("GJC_QUESTION_BINDING_CONFLICT");
		}
		if (
			snapshot.question_id !== questionId ||
			snapshot.session_id !== input.session_id ||
			snapshot.turn_id !== input.turn_id
		)
			throw new JarvisError("GJC_QUESTION_BINDING_CONFLICT");
		return this.createGjcIntent(
			"answer",
			{
				session_id: input.session_id,
				turn_id: input.turn_id,
				question_id: questionId,
				answer_binding: input.answer_binding,
				answer: input.answer,
			},
			idempotencyKey,
			undefined,
			now,
		);
	}
	answerGjcQuestion(
		questionId: string,
		answer: unknown,
		idempotencyKey: string,
		receipt?: unknown,
		now = timestamp(),
	): void {
		const answer_json = json(answer);
		const answer_digest = sha(answer_json);
		this.atomic(() => {
			const question = this.db.prepare("SELECT state FROM gjc_questions WHERE question_id=?").get(questionId) as
				| Row
				| undefined;
			if (!question) throw new JarvisError("GJC_QUESTION_NOT_FOUND");
			const prior = this.db
				.prepare("SELECT idempotency_key,answer_digest FROM gjc_question_answers WHERE question_id=?")
				.get(questionId) as Row | undefined;
			if (prior) {
				if (prior.idempotency_key !== idempotencyKey || prior.answer_digest !== answer_digest)
					throw new JarvisError("GJC_ANSWER_REPLAY_CONFLICT");
				return;
			}
			if (question.state !== "open") throw new JarvisError("GJC_QUESTION_NOT_OPEN");
			this.db
				.prepare(
					"INSERT INTO gjc_question_answers(question_id,idempotency_key,answer_json,answer_digest,receipt_json,created_at) VALUES(?,?,?,?,?,?)",
				)
				.run(questionId, idempotencyKey, answer_json, answer_digest, receipt === undefined ? null : json(receipt), now);
			this.db
				.prepare("UPDATE gjc_questions SET state='answered',answered_at=? WHERE question_id=? AND state='open'")
				.run(now, questionId);
		});
	}
}
