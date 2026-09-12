import Database from "better-sqlite3";
import { createHash, type KeyObject } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { MigrationStore } from "./migration-store.js";
import { OrcaObservationStore } from "./orca-observation-store.js";
import { PersonalContextPersistence } from "./personal-context-persistence.js";
import type { DecisionReceipt, PolicyAuthorization, WorkState } from "./types.js";
import { JarvisError } from "./jarvis-error.js";
import { openUnderSwapAdmission } from "./authority-database-swap-barrier.js";
export { JarvisError } from "./jarvis-error.js";

export type Row = Record<string, unknown>;
export type Credential = { receipt?: DecisionReceipt; policy?: PolicyAuthorization };
export const timestamp = () => new Date().toISOString();
export const json = (value: unknown) => canonicalize(value);
export const sha = (value: unknown) =>
	`sha256:${createHash("sha256")
		.update(typeof value === "string" ? value : json(value))
		.digest("hex")}`;
export const same = (left: unknown, right: unknown) => json(left) === json(right);
export const deterministic = (prefix: string, value: string) => `${prefix}_${sha(`${prefix}\0${value}`).slice(7)}`;
export type ProgressFaultPoint =
	| "before_observation_insert"
	| "after_observation_insert"
	| "after_projection_upsert"
	| "after_outbox_insert_before_commit"
	| "after_stage_commit"
	| "before_receipt_insert"
	| "after_receipt_insert_before_commit"
	| "after_receipt_commit";
export const progressFaultPoints = new Set<ProgressFaultPoint>([
	"before_observation_insert",
	"after_observation_insert",
	"after_projection_upsert",
	"after_outbox_insert_before_commit",
	"after_stage_commit",
	"before_receipt_insert",
	"after_receipt_insert_before_commit",
	"after_receipt_commit",
]);

export abstract class AuthorityDbBase {
	db: Database.Database;
	beforeAckHook: (() => void) | undefined;
	protected progressFaultPoint: ProgressFaultPoint | undefined;
	protected progressTestHook: ((point: ProgressFaultPoint) => void) | undefined;
	protected migrations: MigrationStore;
	protected orcaObservations: OrcaObservationStore;
	protected personalContext: PersonalContextPersistence;
	private readonly migrationsPath: string | undefined;
	constructor(
		readonly filename = process.env.JARVIS_DB ?? "jarvis-authority.sqlite",
		migrationsPath?: string,
		private readonly openOptions: { readonly fileMustExist?: boolean; readonly readonly?: boolean } = {},
	) {
		this.migrationsPath = migrationsPath;
		// Every connection to an authority database is opened here or in reopen(), so this is the
		// one place a swap can exclude new arrivals. A connection admitted after the replacement
		// began would hold an inode the rename is about to orphan.
		this.db = openUnderSwapAdmission(filename, () => new Database(filename, openOptions));
		const stores = this.stores(this.db);
		this.migrations = stores.migrations;
		this.orcaObservations = stores.orcaObservations;
		this.personalContext = stores.personalContext;
		this.configure();
	}
	close(): void {
		this.db.close();
	}
	reopen(): void {
		if (this.db.open) throw new JarvisError("AUTHORITY_DATABASE_ALREADY_OPEN");
		// Reopening is never a creation. A live path that is missing here means a replacement did not
		// finish, and an empty database created in its place would be indistinguishable from the
		// authority it replaced - so this fails instead, loudly, with the file still absent.
		this.db = openUnderSwapAdmission(this.filename,
			() => new Database(this.filename, { ...this.openOptions, fileMustExist: true }));
		const stores = this.stores(this.db);
		this.migrations = stores.migrations;
		this.orcaObservations = stores.orcaObservations;
		this.personalContext = stores.personalContext;
		this.configure();
	}
	private stores(database: Database.Database): {
		readonly migrations: MigrationStore;
		readonly orcaObservations: OrcaObservationStore;
		readonly personalContext: PersonalContextPersistence;
	} {
		const error = (code: string, message?: string): JarvisError => new JarvisError(code, message);
		return { migrations: new MigrationStore(database, this.migrationsPath, error),
			orcaObservations: new OrcaObservationStore(database, error),
			personalContext: new PersonalContextPersistence(database, error) };
	}
	private configure(): void {
		this.db.pragma("busy_timeout = 5000");
		this.db.pragma("foreign_keys = ON");
		this.db.pragma("synchronous = FULL");
		if (!this.db.readonly && String(this.db.pragma("journal_mode", { simple: true })).toLowerCase() !== "wal")
			this.db.pragma("journal_mode = WAL");
	}
	protected atomic<T>(fn: () => T): T {
		// Pre-GJC bridge staging composes the existing progress transaction with its
		// candidate/cursor transaction.  A savepoint preserves all-or-nothing
		// semantics instead of silently splitting the two commits.
		const nested = this.db.inTransaction;
		const name = "jarvis_nested_atomic";
		if (nested) this.db.exec(`SAVEPOINT ${name}`);
		else this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			if (nested) this.db.exec(`RELEASE SAVEPOINT ${name}`);
			else this.db.exec("COMMIT");
			return result;
		} catch (error) {
			if (nested) this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
			else this.db.exec("ROLLBACK");
			throw error;
		}
	}
	protected ledger(workId: string, event: string, payload: unknown): void {
		this.db
			.prepare("INSERT INTO event_ledger(work_id,event_type,payload_json,created_at) VALUES(?,?,?,?)")
			.run(workId, event, json(payload), timestamp());
	}
	protected audit(fact: string, subject: string, payload: unknown): void {
		this.db
			.prepare("INSERT INTO audit_facts(fact_type,subject_id,payload_json,created_at) VALUES(?,?,?,?)")
			.run(fact, subject, json(payload), timestamp());
	}
	protected project(workId: string, state: WorkState): void {
		this.db
			.prepare(
				`INSERT INTO work_projection(work_id,state,updated_at) VALUES(?,?,?) ON CONFLICT(work_id) DO UPDATE
				SET state=excluded.state,updated_at=excluded.updated_at`,
			)
			.run(workId, state, timestamp());
	}
	async migrate(): Promise<void> {
		await this.migrations.migrate();
	}
	async assertMigrationsReady(): Promise<void> {
		await this.migrations.assertReady();
	}
	abstract createGjcIntent(
		kind: "sync" | "dispatch" | "answer",
		payload: unknown,
		idempotencyKey: string,
		continuationId?: string,
		now?: string,
	): string;
	protected abstract work(workId: string): Row;
	protected abstract existing(workId: string): { continuation_id: string; intent_ids: string[] } | undefined;
	protected abstract trusted(keyId: string, purpose: "decision" | "verifier" | "policy", principal?: string): string;
	protected abstract revoked(reference: string): boolean;
	protected abstract policyFor(work: Row, keyId: string, key: KeyObject): PolicyAuthorization;
	protected abstract acceptInside(
		workId: string,
		credential: Credential,
	): { continuation_id: string; intent_ids: string[] };
	protected abstract censusGuardsCurrent(work: Row, at: Date): boolean;
	protected abstract matchReceipt(work: Row, receipt: DecisionReceipt): boolean;
	protected abstract matchPolicy(work: Row, policy: PolicyAuthorization): boolean;
	protected abstract promoteAcknowledgedInside(workId: string): boolean;
	protected abstract tryFinalizeInside(work: Row): boolean;
	protected abstract recoverAcknowledged(): number;
	protected abstract currentIntent(intentId: string): Row | undefined;
	protected abstract currentGuard(current: Row): boolean;
	protected abstract validateWholeSet(current: Row): boolean;
	protected abstract blockCurrentInside(current: Row, outcome: "BLOCKED" | "UNKNOWN"): void;
	protected abstract blockOutbox(
		item: Row,
		outcome: "BLOCKED" | "UNKNOWN",
	): { processed: number; finalized: number; outcome: string };
}
