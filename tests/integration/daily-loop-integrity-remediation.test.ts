import { describe, expect, it } from "vitest";
import { AuthorityDb, DailyControlLoop, DailyLoopError, DailyLoopStore } from "../../src/index.js";
import { tempDb } from "../helpers.js";

const at = new Date("2026-08-30T22:15:00.000Z");
const options = {
	time_zone: "Asia/Seoul" as const,
	owner_id: "linux:stable",
	lease_ms: 60_000,
	deadline_ms: 600_000,
	recovery_window_ms: 7_200_000,
	recovery_lookback_days: 3,
	refresh_freshness_ms: 1_800_000,
	budgets: { max_items: 8, max_work: 8, max_bytes: 4096 },
	clock: () => at,
	event_source: { drain: () => [] },
	refresh_reader: { read: () => null },
};

function persistedState(db: AuthorityDb): string {
	return JSON.stringify({
		runs: db.db.prepare("SELECT * FROM daily_loop_runs ORDER BY run_id").all(),
		steps: db.db.prepare("SELECT * FROM daily_loop_steps ORDER BY run_id,sequence").all(),
		checkpoints: db.db.prepare("SELECT * FROM daily_loop_checkpoints ORDER BY run_id,sequence").all(),
	});
}

async function completedRun(): Promise<{
	readonly db: AuthorityDb;
	readonly runId: string;
}> {
	const db = new AuthorityDb(tempDb());
	await db.migrate();
	const loop = new DailyControlLoop(new DailyLoopStore(db), options);
	const result = await loop.cycle();
	const runId = result.completed_run_ids[0];
	if (runId === undefined) throw new Error("fixture run did not complete");
	return { db, runId };
}

function expectIntegrityFailure(operation: () => unknown): void {
	expect(operation).toThrowError(
		expect.objectContaining({
			constructor: DailyLoopError,
			code: "DAILY_LOOP_INTEGRITY_FAILURE",
		}),
	);
}

describe("Task 20 daily-loop persisted integrity", () => {
	it("rejects an otherwise valid forged checkpoint after reopen without projecting or appending", async () => {
		// Given
		const path = tempDb();
		const first = new AuthorityDb(path);
		await first.migrate();
		const loop = new DailyControlLoop(new DailyLoopStore(first), options);
		const prepared = loop.prepare({ kind: "scheduled" });
		if (prepared.kind !== "prepared") throw new Error("fixture run was not prepared");
		const claim = loop.claim(prepared.run_id);
		const second = new AuthorityDb(path);
		second.db
			.prepare(
				`INSERT INTO daily_loop_checkpoints(
         checkpoint_id,run_id,step_id,sequence,state,previous_digest,checkpoint_digest,
         lease_fence,lease_expires_at,created_at,record_version,detail_json
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
			)
			.run(
				"dlc:forged-digest",
				claim.run_id,
				null,
				1,
				"running",
				null,
				`sha256:${"0".repeat(64)}`,
				claim.fence,
				claim.lease_expires_at,
				at.toISOString(),
				1,
				'"run_started"',
			);
		second.close();
		first.close();
		const reopened = new AuthorityDb(path);
		const store = new DailyLoopStore(reopened);
		const before = persistedState(reopened);

		// When / Then
		expectIntegrityFailure(() => store.start(claim, new Date(at.getTime() + 1)));
		expectIntegrityFailure(() => store.steps(claim.run_id));
		expect(persistedState(reopened)).toBe(before);
		reopened.close();
	});

	it.each(["run", "step", "checkpoint"] as const)("rejects an arbitrary %s digest mutation with zero additional state change", async (target) => {
		// Given
		const { db, runId } = await completedRun();
		if (target === "run") {
			db.db.exec("DROP TRIGGER daily_loop_runs_v1_identity_immutable");
			db.db.prepare("UPDATE daily_loop_runs SET input_digest=? WHERE run_id=?").run(`sha256:${"1".repeat(64)}`, runId);
		} else if (target === "step") {
			db.db.exec("DROP TRIGGER daily_loop_steps_terminal_immutable");
			db.db.exec("DROP TRIGGER daily_loop_steps_digest_material");
			db.db.prepare("UPDATE daily_loop_steps SET evidence_digest=? WHERE run_id=?").run(`sha256:${"2".repeat(64)}`, runId);
		} else {
			db.db.exec("DROP TRIGGER daily_loop_checkpoints_immutable_update");
			db.db.prepare("UPDATE daily_loop_checkpoints SET checkpoint_digest=? WHERE run_id=? AND sequence=1").run(`sha256:${"3".repeat(64)}`, runId);
		}
		const store = new DailyLoopStore(db);
		const before = persistedState(db);

		// When / Then
		expectIntegrityFailure(() => store.steps(runId));
		expect(persistedState(db)).toBe(before);
		db.close();
	});
});
