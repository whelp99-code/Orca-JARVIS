import { json, timestamp, type Row } from "./authority-db-base.js";
import { GjcDispatchAuthorityDb } from "./gjc-dispatch-store.js";
import { gjcWorkerId, leaseExpiry } from "./gjc-lease-identity.js";

const ATTEMPT_STARTED =
	"SELECT payload_json FROM gjc_intent_events WHERE intent_id=? AND event_type='model_send_attempt_started'";

/** Intent-event reads plus the send, attempt and receipt bookkeeping one dispatch writes. */
export abstract class GjcSendAuthorityDb extends GjcDispatchAuthorityDb {
	protected appendGjcIntentEvent(intentId: string, eventType: string, payloadJson: string, now: string): void {
		this.db.prepare("INSERT INTO gjc_intent_events(intent_id,event_type,payload_json,created_at) VALUES(?,?,?,?)")
			.run(intentId, eventType, payloadJson, now);
	}

	gjcIntentIdForKey(idempotencyKey: string): string | undefined {
		const row = this.db.prepare("SELECT intent_id FROM gjc_intents WHERE idempotency_key=?").get(idempotencyKey) as Row | undefined;
		return typeof row?.intent_id === "string" ? row.intent_id : undefined;
	}

	gjcIntentHasEvent(intentId: string, eventType: string): boolean {
		return this.db.prepare("SELECT 1 FROM gjc_intent_events WHERE intent_id=? AND event_type=? LIMIT 1").get(intentId, eventType) !== undefined;
	}

	gjcIntentHasFenceEvent(intentId: string, eventType: string, fence: number): boolean {
		const rows = this.db.prepare("SELECT payload_json FROM gjc_intent_events WHERE intent_id=? AND event_type=?").all(intentId, eventType) as Row[];
		for (const row of rows) {
			if (typeof row.payload_json !== "string") continue;
			try {
				const payload = JSON.parse(row.payload_json) as { lease_fence?: unknown };
				if (Number(payload.lease_fence) === fence) return true;
			} catch {
				continue;
			}
		}
		return false;
	}

	gjcSendDeliveryId(intentId: string): string | undefined {
		const row = this.db.prepare(
			"SELECT payload_json FROM gjc_intent_events WHERE intent_id=? AND event_type='model_send_started'"
			+ " ORDER BY created_at DESC, rowid DESC LIMIT 1",
		).get(intentId) as Row | undefined;
		if (row === undefined || typeof row.payload_json !== "string") return undefined;
		try {
			const payload = JSON.parse(row.payload_json) as { delivery_id?: unknown };
			return typeof payload.delivery_id === "string" ? payload.delivery_id : undefined;
		} catch {
			return undefined;
		}
	}

	recordGjcSendStarted(intentId: string, deliveryId: string, now = timestamp(), leaseFence = 0): void {
		this.atomic(() => {
			this.appendGjcIntentEvent(intentId, "model_send_started", json({ delivery_id: deliveryId, lease_fence: leaseFence }), now);
		});
	}

	recordGjcSendFailed(intentId: string, now = timestamp(), leaseFence = 0): void {
		this.atomic(() => {
			this.appendGjcIntentEvent(intentId, "model_send_failed", json({ lease_fence: leaseFence }), now);
		});
	}

	recordGjcSendAttemptStarted(intentId: string, attemptId: string, now = timestamp(), leaseFence = 0): void {
		this.atomic(() => {
			this.appendGjcIntentEvent(intentId, "model_send_attempt_started", json({ attempt_id: attemptId, lease_fence: leaseFence }), now);
		});
	}

	recordGjcSendAttemptFailed(intentId: string, attemptId: string, now = timestamp(), leaseFence = 0): void {
		this.atomic(() => {
			this.appendGjcIntentEvent(intentId, "model_send_attempt_failed", json({ attempt_id: attemptId, lease_fence: leaseFence }), now);
		});
	}

	latestGjcSendAttempt(intentId: string, leaseFence?: number): { attempt_id: string; failed: boolean } | undefined {
		const row = (leaseFence === undefined
			? this.db.prepare(ATTEMPT_STARTED + " ORDER BY rowid DESC LIMIT 1").get(intentId)
			: this.db.prepare(ATTEMPT_STARTED + " AND json_extract(payload_json,'$.lease_fence')=? ORDER BY rowid DESC LIMIT 1")
				.get(intentId, leaseFence)) as Row | undefined;
		if (row === undefined || typeof row.payload_json !== "string") return undefined;
		try {
			const payload = JSON.parse(row.payload_json) as { attempt_id?: unknown };
			if (typeof payload.attempt_id !== "string") return undefined;
			const failed = this.db.prepare(
				"SELECT 1 FROM gjc_intent_events WHERE intent_id=? AND event_type='model_send_attempt_failed'"
				+ " AND json_extract(payload_json,'$.attempt_id')=? LIMIT 1",
			).get(intentId, payload.attempt_id) !== undefined;
			return { attempt_id: payload.attempt_id, failed };
		} catch {
			return undefined;
		}
	}

	recordGjcReconciledReceipt(intentId: string, now = timestamp()): void {
		const worker = gjcWorkerId();
		const expires = leaseExpiry(now);
		this.atomic(() => {
			if (this.gjcIntentHasEvent(intentId, "model_dispatched")) return;
			if (!this.gjcIntentHasEvent(intentId, "model_send_started")) return;
			this.db.prepare("UPDATE gjc_intents SET lease_owner=?,lease_expires_at=? WHERE intent_id=?").run(worker, expires, intentId);
			this.appendGjcIntentEvent(intentId, "model_dispatched", json({ recovered: true, worker }), now);
		});
	}

	recordGjcModelDispatched(intentId: string, now = timestamp(), leaseFence?: number, worker = gjcWorkerId()): void {
		this.atomic(() => {
			const owned = this.db.prepare("SELECT lease_fence,lease_owner FROM gjc_intents WHERE intent_id=?").get(intentId) as Row | undefined;
			if (owned === undefined) return;
			if (leaseFence !== undefined && (Number(owned.lease_fence) !== leaseFence || owned.lease_owner !== worker)) return;
			this.appendGjcIntentEvent(intentId, "model_dispatched", json({ lease_fence: Number(owned.lease_fence), worker }), now);
			this.db.prepare("UPDATE gjc_intents SET state=CASE WHEN state='uncertain' THEN 'pending' ELSE state END WHERE intent_id=?").run(intentId);
		});
	}

	markGjcIntentUncertain(intentId: string, now = timestamp()): void {
		this.atomic(() => {
			this.db.prepare("UPDATE gjc_intents SET state='uncertain' WHERE intent_id=? AND state IN ('pending','claimed')").run(intentId);
			this.appendGjcIntentEvent(intentId, "dispatch_failed", json({ failure_code: "GJC_MODEL_DISPATCH_UNAVAILABLE" }), now);
		});
	}}
