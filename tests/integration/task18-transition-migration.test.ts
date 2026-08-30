import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb, RecommendationError, Recommendations, TaskTimeline } from "../../src/index.js";
import { persistTask18Context, RECOMMENDATION_ID, task18Request } from "../fixtures/recommendation-fixture.js";
import { tempDb } from "../helpers.js";

const MIGRATION = "034_recommendation_transition_identity.sql";
const LATER_MIGRATIONS = ["035_daily_loop_durable_guards.sql", "036_notification_intent_immutable_delete.sql",
	"037_recommendation_work_runtime.sql"] as const;
const OLD_HASHES = {
	"032_personal_context.sql": "a419b923fa3c2dfe6f957199256ad3ad5e5601e2fd60e0ba3ea5d3b7277c841b",
	"033_personal_operations.sql": "33e2755a78d87d281bfd3bfe7b18aed07ee3b93216f5131c4453329f169596b4",
} as const;

function hash(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("Task 18 transition identity migration", () => {
	it("applies after exact 033 with immutable old bytes and records zero legacy terminal evidence", async () => {
		// Given
		const root = mkdtempSync(join(tmpdir(), "jarvis-task18-034-"));
		const migrations = join(root, "migrations");
		cpSync(join(process.cwd(), "migrations"), migrations, { recursive: true });
		unlinkSync(join(migrations, MIGRATION));
		for (const later of LATER_MIGRATIONS) unlinkSync(join(migrations, later));
		const db = new AuthorityDb(tempDb(), migrations);
		try {
			await db.migrate();
			expect(db.db.prepare("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1").get()).toEqual({ id: "033_personal_operations.sql" });
			cpSync(join(process.cwd(), "migrations", MIGRATION), join(migrations, MIGRATION));
			// When
			await db.migrate();
			// Then
			expect(db.db.prepare("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1").get()).toEqual({ id: MIGRATION });
			expect(db.db.prepare("SELECT terminal_count,superseded_count FROM personal_recommendation_transition_migration_evidence").get()).toEqual({
				terminal_count: 0,
				superseded_count: 0,
			});
			const columns = db.db
				.prepare("PRAGMA table_info(personal_recommendation_action_events)")
				.all()
				.map((row) => (typeof row === "object" && row !== null ? Reflect.get(row, "name") : undefined));
			expect(columns).toEqual(expect.arrayContaining(["transition_occurred_at", "transition_digest", "replacement_recommendation_id"]));
			expect(db.db.pragma("foreign_key_check")).toEqual([]);
			for (const [name, digest] of Object.entries(OLD_HASHES)) {
				expect(hash(join(process.cwd(), "migrations", name))).toBe(digest);
			}
			appendFileSync(join(migrations, MIGRATION), "\n-- checksum probe\n");
			await expect(db.assertMigrationsReady()).rejects.toMatchObject({
				code: "MIGRATION_CHECKSUM_MISMATCH",
			});
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("guards forward transition metadata, replacement identity, and append-only bytes", async () => {
		// Given
		const db = new AuthorityDb(tempDb());
		await db.migrate();
		try {
			const context = persistTask18Context(db);
			const created = new Recommendations(db).create(task18Request(context));
			const insert = db.db.prepare(
				`INSERT INTO personal_recommendation_action_events(
           recommendation_id,rank,state,evidence_digest,occurred_at,
           transition_occurred_at,transition_digest,replacement_recommendation_id
         ) VALUES(?,?,?,?,?,?,?,?)`,
			);
			const digest = `sha256:${"a".repeat(64)}`;
			const at = "2026-08-28T12:20:00.000Z";
			// When / Then
			expect(() => insert.run(RECOMMENDATION_ID, 1, "accepted", created.evidence_digest, at, null, null, null)).toThrow(/transition identity/i);
			expect(() => insert.run(RECOMMENDATION_ID, 1, "accepted", created.evidence_digest, at, at, "bad", null)).toThrow(/constraint/i);
			expect(() => insert.run(RECOMMENDATION_ID, 2, "accepted", created.evidence_digest, "not-a-timestamp", "not-a-timestamp", digest, null)).toThrow();
			expect(() => insert.run(RECOMMENDATION_ID, 1, "accepted", created.evidence_digest, at, at, digest, RECOMMENDATION_ID)).toThrow(/transition identity/i);
			expect(() =>
				insert.run(RECOMMENDATION_ID, 1, "superseded", created.evidence_digest, at, at, digest, "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6fffff"),
			).toThrow(/foreign key/i);
			expect(() =>
				db.db.prepare("UPDATE personal_recommendation_action_events SET transition_digest=? WHERE recommendation_id=?").run(digest, RECOMMENDATION_ID),
			).toThrow(/immutable/i);
			expect(() => db.db.prepare("DELETE FROM personal_recommendation_action_events WHERE recommendation_id=?").run(RECOMMENDATION_ID)).toThrow(/immutable/i);
		} finally {
			db.close();
		}
	});

	it("preserves readable legacy terminals and fails closed for legacy supersession without a direct relation", async () => {
		// Given
		const db = new AuthorityDb(tempDb());
		await db.migrate();
		try {
			const context = persistTask18Context(db);
			const created = new Recommendations(db).create(task18Request(context));
			db.db.exec("DROP TRIGGER personal_action_event_transition_identity");
			const insert = db.db.prepare(
				"INSERT INTO personal_recommendation_action_events(recommendation_id,rank,state,evidence_digest,occurred_at) VALUES(?,?,?,?,?)",
			);
			insert.run(RECOMMENDATION_ID, 1, "accepted", created.evidence_digest, "2026-08-28T12:20:00.000Z");
			// When / Then
			expect(() => new Recommendations(db).project("2026-08-28T12:30:00.000Z")).not.toThrow();
			expect(() => db.getPersonalRecommendation(created.recommendation.id)).not.toThrow();
			expect(() => new TaskTimeline(db).timeline(RECOMMENDATION_ID, 10)).not.toThrow();
			insert.run(RECOMMENDATION_ID, 2, "superseded", created.evidence_digest, "2026-08-28T12:20:00.000Z");
			expect(() => new Recommendations(db).project("2026-08-28T12:30:00.000Z")).toThrowError(
				expect.objectContaining({
					constructor: RecommendationError,
					code: "RECOMMENDATION_INPUT_INVALID",
				}),
			);
		} finally {
			db.close();
		}
	});

	it("requires the exact expiry compatibility time before, at, and after the storage deadline", async () => {
		// Given
		const db = new AuthorityDb(tempDb());
		await db.migrate();
		try {
			const context = persistTask18Context(db);
			const created = new Recommendations(db).create(task18Request(context));
			const insert = db.db.prepare(
				`INSERT INTO personal_recommendation_action_events(
           recommendation_id,rank,state,evidence_digest,occurred_at,
           transition_occurred_at,transition_digest,replacement_recommendation_id
         ) VALUES(?,?,'expired',?,?,?,?,NULL)`,
			);
			const digest = `sha256:${"b".repeat(64)}`;
			const storage = created.recommendation.expires_at;
			const before = created.recommendation.freshness.fresh_until;
			const after = new Date(Date.parse(storage) + 1).toISOString();
			const arbitraryLater = new Date(Date.parse(after) + 1).toISOString();
			// When / Then
			expect(() => insert.run(RECOMMENDATION_ID, 1, created.evidence_digest, arbitraryLater, before, digest)).toThrow(/transition identity/i);
			expect(() => insert.run(RECOMMENDATION_ID, 2, created.evidence_digest, after, storage, digest)).toThrow(/transition identity/i);
			expect(() => insert.run(RECOMMENDATION_ID, 3, created.evidence_digest, arbitraryLater, after, digest)).toThrow(/transition identity/i);
			expect(() => insert.run(RECOMMENDATION_ID, 1, created.evidence_digest, storage, before, digest)).not.toThrow();
			expect(() => insert.run(RECOMMENDATION_ID, 2, created.evidence_digest, storage, storage, `sha256:${"c".repeat(64)}`)).not.toThrow();
			expect(() => insert.run(RECOMMENDATION_ID, 3, created.evidence_digest, after, after, `sha256:${"d".repeat(64)}`)).not.toThrow();
		} finally {
			db.close();
		}
	});
});
