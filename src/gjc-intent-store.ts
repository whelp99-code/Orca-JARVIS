import { JarvisError, deterministic, json, sha, timestamp, type Row } from "./authority-db-base.js";
import { GjcDispatchAuthorityDb } from "./gjc-dispatch-store.js";

export abstract class GjcIntentAuthorityDb extends GjcDispatchAuthorityDb {
	gjcIntentIdForKey(idempotencyKey: string): string | undefined {
		const row = this.db.prepare("SELECT intent_id FROM gjc_intents WHERE idempotency_key=?").get(idempotencyKey) as Row | undefined;
		return typeof row?.intent_id === "string" ? row.intent_id : undefined;
	}

	gjcIntentHasEvent(intentId: string, eventType: string): boolean {
		return this.db.prepare("SELECT 1 FROM gjc_intent_events WHERE intent_id=? AND event_type=? LIMIT 1").get(intentId, eventType) !== undefined;
	}

	recordGjcModelDispatched(intentId: string, now = timestamp()): void {
		this.atomic(() => {
			this.db.prepare("INSERT INTO gjc_intent_events(intent_id,event_type,payload_json,created_at) VALUES(?,?,?,?)").run(intentId, "model_dispatched", json({}), now);
			this.db.prepare("UPDATE gjc_intents SET state=CASE WHEN state='uncertain' THEN 'pending' ELSE state END WHERE intent_id=?").run(intentId);
		});
	}

	reserveGjcIntent(
		kind: "sync" | "dispatch" | "answer",
		payload: unknown,
		idempotencyKey: string,
		continuationId?: string,
		now = timestamp(),
	): { intent_id: string; reserved: boolean } {
		if (!this.gjcOperational()) throw new JarvisError("GJC_NOT_CONNECTED");
		if (!idempotencyKey) throw new JarvisError("GJC_IDEMPOTENCY_REQUIRED");
		const intentId = deterministic("gjc", idempotencyKey);
		const payload_json = json(payload);
		const payload_digest = sha(payload_json);
		return this.atomic(() => {
			const prior = this.db.prepare("SELECT intent_id,payload_digest,kind,continuation_id,state FROM gjc_intents WHERE idempotency_key=?").get(idempotencyKey) as Row | undefined;
			if (prior) {
				if (prior.payload_digest !== payload_digest || prior.kind !== kind || (prior.continuation_id ?? null) !== (continuationId ?? null))
					throw new JarvisError("GJC_INTENT_REPLAY_CONFLICT");
				const id = String(prior.intent_id);
				if (this.gjcIntentHasEvent(id, "model_dispatched") || prior.state !== "uncertain")
					return { intent_id: id, reserved: false };
				this.db.prepare("UPDATE gjc_intents SET state='pending' WHERE intent_id=?").run(id);
				return { intent_id: id, reserved: true };
			}
			this.db.prepare("INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at) VALUES(?,?,?,?,?,?,?,?)").run(intentId, continuationId ?? null, kind, payload_json, payload_digest, idempotencyKey, "pending", now);
			this.db.prepare("INSERT INTO gjc_intent_events(intent_id,event_type,payload_json,created_at) VALUES(?,?,?,?)").run(intentId, "created", json({ kind, idempotency_key: idempotencyKey }), now);
			return { intent_id: intentId, reserved: true };
		});
	}

	createGjcIntent(
		kind: "sync" | "dispatch" | "answer",
		payload: unknown,
		idempotencyKey: string,
		continuationId?: string,
		now = timestamp(),
	): string {
		if (!this.gjcOperational()) throw new JarvisError("GJC_NOT_CONNECTED");
		if (!idempotencyKey) throw new JarvisError("GJC_IDEMPOTENCY_REQUIRED");
		if (kind === "sync") {
			const config = this.gjcConfig();
			const input = payload as Record<string, unknown>;
			if (
				!config ||
				!input ||
				typeof input !== "object" ||
				Array.isArray(input) ||
				Object.keys(input).sort().join(",") !== "session_id,turn_id" ||
				input.session_id !== config.session_id ||
				typeof input.turn_id !== "string" ||
				!input.turn_id
			)
				throw new JarvisError("GJC_SYNC_SCHEMA_INVALID");
		}
		const intentId = deterministic("gjc", idempotencyKey);
		const payload_json = json(payload);
		const payload_digest = sha(payload_json);
		this.atomic(() => {
			const prior = this.db
				.prepare("SELECT payload_digest,kind,continuation_id FROM gjc_intents WHERE idempotency_key=?")
				.get(idempotencyKey) as Row | undefined;
			if (prior) {
				if (
					prior.payload_digest !== payload_digest ||
					prior.kind !== kind ||
					(prior.continuation_id ?? null) !== (continuationId ?? null)
				)
					throw new JarvisError("GJC_INTENT_REPLAY_CONFLICT");
				return;
			}
			this.db
				.prepare(
					"INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at) VALUES(?,?,?,?,?,?,?,?)",
				)
				.run(intentId, continuationId ?? null, kind, payload_json, payload_digest, idempotencyKey, "pending", now);
			this.db
				.prepare("INSERT INTO gjc_intent_events(intent_id,event_type,payload_json,created_at) VALUES(?,?,?,?)")
				.run(intentId, "created", json({ kind, idempotency_key: idempotencyKey }), now);
		});
		return intentId;
	}
	recoverExpiredGjcIntents(now = timestamp()): number {
		if (!Number.isFinite(Date.parse(now))) throw new JarvisError("GJC_LEASE_INVALID");
		return this.atomic(() => {
			const expired = this.db.prepare(
				"SELECT intent_id,kind,lease_fence FROM gjc_intents WHERE state='claimed' AND lease_expires_at<=?",
			).all(now) as Row[];
			for (const row of expired) {
				// Reads can be repeated. A lost mutation acknowledgement cannot prove non-delivery.
				const state = row.kind === "sync" ? "pending" : "uncertain";
				const failureCode = state === "uncertain" ? "GJC_CLAIM_EXPIRED_UNCERTAIN" : null;
				this.db.prepare(
					"UPDATE gjc_intents SET state=?,failure_code=?,lease_owner=NULL,lease_expires_at=NULL WHERE intent_id=?",
				).run(state, failureCode, row.intent_id);
				this.db.prepare(
					"INSERT INTO gjc_intent_events(intent_id,event_type,payload_json,created_at) VALUES(?,?,?,?)",
				).run(row.intent_id, "lease_expired", json({
					state, fence: row.lease_fence, failure_code: failureCode,
				}), now);
			}
			return expired.length;
		});
	}
	claimGjcIntent(
		intentId: string,
		worker: string,
		now = timestamp(),
		leaseMs = 60_000,
	): Record<string, unknown> | null {
		if (!worker || leaseMs < 1) throw new JarvisError("GJC_LEASE_INVALID");
		return this.atomic(() => {
			this.recoverExpiredGjcIntents(now);
			const row = this.db.prepare("SELECT * FROM gjc_intents WHERE intent_id=?").get(intentId) as Row | undefined;
			if (!row) throw new JarvisError("GJC_INTENT_NOT_FOUND");
			if (row.state !== "pending") return null;
			const fence = Number(row.lease_fence) + 1;
			const expires = new Date(Date.parse(now) + leaseMs).toISOString();
			const changed = this.db
				.prepare(
					"UPDATE gjc_intents SET state='claimed',attempts=attempts+1,lease_owner=?,lease_fence=?,lease_expires_at=? WHERE intent_id=? AND state='pending'",
				)
				.run(worker, fence, expires, intentId);
			if (changed.changes !== 1) return null;
			this.db
				.prepare("INSERT INTO gjc_intent_events(intent_id,event_type,payload_json,created_at) VALUES(?,?,?,?)")
				.run(intentId, "claimed", json({ worker, fence }), now);
			return { ...row, lease_fence: fence, lease_expires_at: expires };
		});
	}
	requireGjcIntentLease(intentId: string, fence: number, now = timestamp()): Row {
		const row = this.db.prepare("SELECT * FROM gjc_intents WHERE intent_id=?").get(intentId) as Row | undefined;
		const at = Date.parse(now);
		const expires = typeof row?.lease_expires_at === "string" ? Date.parse(row.lease_expires_at) : NaN;
		if (!row || row.state !== "claimed" || Number(row.lease_fence) !== fence ||
			!Number.isFinite(at) || !Number.isFinite(expires) || expires <= at)
			throw new JarvisError("GJC_STALE_LEASE");
		return row;
	}
	settleGjcIntent(
		intentId: string,
		fence: number,
		result: { status: "accepted" | "completed" | "failed" | "uncertain"; receipt?: unknown; failure_code?: string },
		now = timestamp(),
	): void {
		const valid = new Set(["accepted", "completed", "failed", "uncertain"]);
		if (!valid.has(result.status)) throw new JarvisError("GJC_STATUS_INVALID");
		this.atomic(() => {
			const row = this.requireGjcIntentLease(intentId, fence, now);
			const receipt = result.receipt === undefined ? null : json(result.receipt);
			const acceptedAt = result.status === "accepted" || result.status === "completed" ? now : null;
			const completedAt = result.status === "completed" || result.status === "failed" ? now : null;
			this.db
				.prepare(
					`UPDATE gjc_intents SET
					state=?,receipt_json=COALESCE(?,receipt_json),accepted_at=COALESCE(?,accepted_at),
					completed_at=COALESCE(?,completed_at),failure_code=?,lease_owner=NULL,lease_expires_at=NULL
					WHERE intent_id=? AND state='claimed' AND lease_fence=?`,
				)
				.run(result.status, receipt, acceptedAt, completedAt, result.failure_code ?? null, intentId, fence);
			this.db
				.prepare("INSERT INTO gjc_intent_events(intent_id,event_type,payload_json,created_at) VALUES(?,?,?,?)")
				.run(
					intentId,
					result.status,
					json({ receipt: result.receipt ?? null, failure_code: result.failure_code ?? null }),
					now,
				);
			if (row.kind === "dispatch" && (result.status === "accepted" || result.status === "completed")) {
				const reply = result.receipt as Record<string, unknown> | undefined;
				const config = this.gjcConfig();
				if (
					!reply ||
					!config ||
					reply.session_id !== config.session_id ||
					typeof reply.turn_id !== "string" ||
					!reply.turn_id
				)
					throw new JarvisError("GJC_DISPATCH_RECEIPT_INVALID");
				this.db
					.prepare(
						"INSERT INTO gjc_dispatch_receipts(intent_id,session_id,turn_id,receipt_json,accepted_at) VALUES(?,?,?,?,?)",
					)
					.run(intentId, reply.session_id, reply.turn_id, receipt, now);
				const syncKey = deterministic("gjc-reconcile", `${intentId}:${reply.turn_id}`);
				const syncId = deterministic("gjc", syncKey);
				const payload = json({ session_id: config.session_id, turn_id: reply.turn_id });
				this.db
					.prepare(
						`INSERT INTO
						gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at)
						VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`,
					)
					.run(syncId, row.continuation_id, "sync", payload, sha(payload), syncKey, "pending", now);
				this.db
					.prepare(
						"INSERT INTO gjc_intent_events(intent_id,event_type,payload_json,created_at) SELECT ?,?,?,? WHERE changes()=1",
					)
					.run(syncId, "created", json({ kind: "sync", source_intent_id: intentId }), now);
			}
		});
	}
}
