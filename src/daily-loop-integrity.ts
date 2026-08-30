import { createHash } from "node:crypto";
import type { AuthorityDb } from "./db.js";
import { canonicalize } from "./canonical.js";
import { parseStoreDetail } from "./daily-loop-store-input.js";
import { DailyLoopError } from "./daily-loop-types.js";
import { persistenceNumber, persistenceRow, persistenceText, type PersistenceRow } from "./personal-persistence-values.js";

const fail = (): never => {
	throw new DailyLoopError("DAILY_LOOP_INTEGRITY_FAILURE");
};

function nullableText(value: unknown): string | null {
	return value === null ? null : persistenceText(value);
}

function canonicalJson(value: unknown): {
	readonly json: string;
	readonly value: unknown;
} {
	const stored = persistenceText(value);
	try {
		const parsed = parseStoreDetail(JSON.parse(stored));
		const json = canonicalize(parsed);
		if (stored !== json) return fail();
		return { json, value: parsed };
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return fail();
	}
}

function hashJson(json: string): string {
	return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

function version(row: PersistenceRow): number {
	const value = persistenceNumber(row["record_version"]);
	return value === 0 || value === 1 ? value : fail();
}

function assertRun(row: PersistenceRow): void {
	if (version(row) === 0) return;
	const input = canonicalJson(row["input_json"]);
	const expected = `sha256:${createHash("sha256").update("orca-jarvis/daily-loop-input/v1\0").update(input.json).digest("hex")}`;
	if (row["input_digest"] !== expected) fail();
}

function assertSteps(rows: readonly PersistenceRow[]): void {
	for (const row of rows) {
		if (version(row) === 0) continue;
		const state = persistenceText(row["state"]);
		if (state === "pending") {
			if (row["detail_json"] !== null || row["evidence_digest"] !== null || row["result_digest"] !== null) fail();
			continue;
		}
		const detail = canonicalJson(row["detail_json"]);
		if (row["evidence_digest"] !== hashJson(detail.json)) fail();
		const expectedResult = state === "completed" ? hashJson(canonicalize({ detail: detail.value, state: "completed" })) : null;
		if (row["result_digest"] !== expectedResult) fail();
	}
}

function assertCheckpoints(rows: readonly PersistenceRow[], stepCount: number): void {
	let previousSequence: number | null = null;
	let previousDigest: string | null = null;
	let versionOneCount = 0;
	let foundVersionOne = false;
	for (const row of rows) {
		const rowVersion = version(row);
		const sequence = persistenceNumber(row["sequence"]);
		const checkpointDigest = persistenceText(row["checkpoint_digest"]);
		if (!Number.isSafeInteger(sequence) || sequence < 1) fail();
		if (rowVersion === 0) {
			if (foundVersionOne) fail();
			previousSequence = sequence;
			previousDigest = checkpointDigest;
			continue;
		}
		foundVersionOne = true;
		versionOneCount += 1;
		if (versionOneCount > stepCount * 3 + 3) fail();
		const expectedSequence: number = previousSequence === null ? 1 : previousSequence + 1;
		if (sequence !== expectedSequence || nullableText(row["previous_digest"]) !== previousDigest) fail();
		const detail = canonicalJson(row["detail_json"]);
		const expectedDigest = hashJson(
			canonicalize({
				run_id: persistenceText(row["run_id"]),
				step_id: nullableText(row["step_id"]),
				sequence,
				state: persistenceText(row["state"]),
				previous_digest: previousDigest,
				lease_fence: persistenceNumber(row["lease_fence"]),
				detail: detail.value,
				created_at: persistenceText(row["created_at"]),
			}),
		);
		if (checkpointDigest !== expectedDigest) fail();
		previousSequence = sequence;
		previousDigest = checkpointDigest;
	}
}

export function assertDailyLoopIntegrity(authority: AuthorityDb, runId: string): void {
	const runValue = authority.db.prepare("SELECT record_version,input_json,input_digest FROM daily_loop_runs WHERE run_id=?").get(runId);
	if (runValue === undefined) return;
	assertRun(persistenceRow(runValue));
	const steps = authority.db
		.prepare(
			`SELECT record_version,state,detail_json,evidence_digest,result_digest
     FROM daily_loop_steps WHERE run_id=? ORDER BY sequence`,
		)
		.all(runId)
		.map(persistenceRow);
	assertSteps(steps);
	const checkpoints = authority.db
		.prepare(
			`SELECT run_id,step_id,sequence,state,previous_digest,checkpoint_digest,lease_fence,
            created_at,record_version,detail_json
     FROM daily_loop_checkpoints WHERE run_id=? ORDER BY sequence`,
		)
		.all(runId)
		.map(persistenceRow);
	assertCheckpoints(checkpoints, steps.length);
}
