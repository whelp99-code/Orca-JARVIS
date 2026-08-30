import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalize } from "./canonical.js";
import { quietHoursDecision } from "./daily-control-loop.js";

export type NotificationUrgency = "info" | "action" | "critical";
export type NotificationChannel = "mac" | "browser" | "phone";
export type NotificationInput = Readonly<{
	intent_id: string;
	correlation_id: string;
	idempotency_key: string;
	dedup_key: string;
	urgency: NotificationUrgency;
	channel: NotificationChannel;
	title: string;
	summary: string;
	resource_id: string;
	expires_at: string;
	now: string;
}>;
export type NotificationIntent = Readonly<
	NotificationInput & {
		state: "created" | "deferred" | "queued" | "suppressed" | "expired";
		deep_link: string;
	}
>;

function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}
function text(value: string, max: number): string {
	if (!value || value.length > max || /(?:password|secret|token|api[_ -]?key|cookie|private[_ -]?key)/iu.test(value))
		throw new Error("NOTIFICATION_REDACTION_REQUIRED");
	return value;
}
function validIso(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}

export function createNotificationIntent(input: NotificationInput): NotificationIntent {
	if (!validIso(input.now) || !validIso(input.expires_at) || Date.parse(input.expires_at) <= Date.parse(input.now))
		throw new Error("NOTIFICATION_EXPIRY_INVALID");
	const title = text(input.title, 256);
	const summary = text(input.summary, 512);
	const resource_id = text(input.resource_id, 256);
	if (!/^resource:[a-z0-9._:-]+$/u.test(resource_id)) throw new Error("NOTIFICATION_RESOURCE_INVALID");
	const quiet = quietHoursDecision(new Date(input.now), input.urgency);
	const state = quiet === "bypass" ? "queued" : quiet === "defer" ? "deferred" : "created";
	return {
		...input,
		title,
		summary,
		resource_id,
		deep_link: `jarvis://resource/${encodeURIComponent(resource_id)}`,
		state,
	};
}

export class NotificationIntentStore {
	constructor(private readonly db: Database.Database) {}

	enqueue(input: NotificationInput): NotificationIntent {
		const intent = createNotificationIntent(input);
		const preview = JSON.stringify({
			title: intent.title,
			summary: intent.summary,
			resource_id: intent.resource_id,
		});
		this.db
			.prepare(`INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,
        redacted_preview,deep_link,state,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dedup_key) DO NOTHING`)
			.run(
				intent.intent_id,
				intent.correlation_id,
				intent.idempotency_key,
				intent.dedup_key,
				intent.urgency,
				intent.channel,
				preview,
				intent.deep_link,
				intent.state,
				intent.expires_at,
				intent.now,
				intent.now,
			);
		const row = this.db.prepare("SELECT intent_id,state FROM notification_intents WHERE dedup_key=?").get(intent.dedup_key) as
			| { intent_id: string; state: NotificationIntent["state"] }
			| undefined;
		if (!row) throw new Error("NOTIFICATION_PERSISTENCE_FAILED");
		if (row.intent_id !== intent.intent_id) throw new Error("NOTIFICATION_DEDUP_CONFLICT");
		return { ...intent, state: row.state };
	}

	expire(now: string): number {
		if (!validIso(now)) throw new Error("NOTIFICATION_TIME_INVALID");
		return this.db
			.prepare(
				"UPDATE notification_intents SET state='expired',updated_at=? WHERE state IN ('created','deferred','queued') AND expires_at<=?",
			)
			.run(now, now).changes;
	}

	list(state?: NotificationIntent["state"]): readonly NotificationIntent[] {
		const rows = (
			state === undefined
				? this.db.prepare("SELECT * FROM notification_intents ORDER BY created_at,intent_id").all()
				: this.db.prepare("SELECT * FROM notification_intents WHERE state=? ORDER BY created_at,intent_id").all(state)
		) as Array<Record<string, unknown>>;
		return rows.map((row) => {
			const preview = JSON.parse(String(row.redacted_preview)) as {
				title: string;
				summary: string;
				resource_id: string;
			};
			return {
				intent_id: String(row.intent_id),
				correlation_id: String(row.correlation_id),
				idempotency_key: String(row.idempotency_key),
				dedup_key: String(row.dedup_key),
				urgency: String(row.urgency) as NotificationUrgency,
				channel: String(row.channel) as NotificationChannel,
				title: preview.title,
				summary: preview.summary,
				resource_id: preview.resource_id,
				expires_at: String(row.expires_at),
				now: String(row.created_at),
				deep_link: String(row.deep_link),
				state: String(row.state) as NotificationIntent["state"],
			};
		});
	}

	static dedupKey(input: Omit<NotificationInput, "dedup_key">): string {
		return digest({
			correlation_id: input.correlation_id,
			resource_id: input.resource_id,
			urgency: input.urgency,
		});
	}
}
