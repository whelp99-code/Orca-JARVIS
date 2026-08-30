import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { memoryPolicy, MEMORY_NOW, verifiedMemoryInput } from "../fixtures/memory-candidate-fixture.js";
import {
  closeMemoryDatabase,
  memoryDatabase,
  memoryTableCounts,
  seedMemoryVerification,
} from "../fixtures/memory-candidate-store.js";

type RaceResult = {
  readonly ok: boolean;
  readonly candidate_id?: string;
  readonly classification_digest?: string;
  readonly state?: string;
  readonly code?: string;
};

const raceWorker = new URL("../../scripts/task27-memory-race-worker.mjs", import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("record required");
  return value;
}

async function race(path: string, inputs: readonly [unknown, unknown]): Promise<readonly RaceResult[]> {
  const workers = inputs.map(input => new Worker(raceWorker, {
    workerData: { path, input, policy: memoryPolicy(), clock: MEMORY_NOW },
  }));
  const signal = AbortSignal.timeout(5_000);
  try {
    await Promise.all(workers.map(async worker => {
      const [message] = await once(worker, "message", { signal });
      expect(record(message)["kind"]).toBe("ready");
    }));
    const results = workers.map(async worker => {
      const [message] = await once(worker, "message", { signal });
      const value = record(message);
      if (value["kind"] !== "result") throw new TypeError("Task 27 race result required");
      return {
        ok: value["ok"] === true,
        candidate_id: typeof value["candidate_id"] === "string" ? value["candidate_id"] : undefined,
        classification_digest: typeof value["classification_digest"] === "string"
          ? value["classification_digest"] : undefined,
        state: typeof value["state"] === "string" ? value["state"] : undefined,
        code: typeof value["code"] === "string" ? value["code"] : undefined,
      };
    });
    for (const worker of workers) worker.postMessage({ kind: "go" });
    return await Promise.all(results);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}

describe("Task 27 two-connection candidate convergence", () => {
  it("releases two SQLite writers together and persists one candidate, metadata row, and event", async () => {
    // Given: two independent package-root workers connected to one migrated SQLite authority database.
    const database = await memoryDatabase();
    try {
      const input = verifiedMemoryInput();
      seedMemoryVerification(database.authority, input);

      // When: both workers announce readiness before the same candidate is released.
      const results = await race(database.path, [input, input]);

      // Then: both return one byte-identical canonical result and no duplicate audit state exists.
      expect(results.every(result => result.ok)).toBe(true);
      expect(new Set(results.map(result => result.candidate_id)).size).toBe(1);
      expect(new Set(results.map(result => result.classification_digest)).size).toBe(1);
      expect(results.map(result => result.state)).toEqual(["approved", "approved"]);
      for (const table of ["memory_candidates", "memory_candidate_classifications", "memory_candidate_idempotency",
        "personal_operation_audit_events"]) {
        expect(record(database.authority.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())["count"], table).toBe(1);
      }
      expect(record(database.authority.db.prepare(
        "SELECT COUNT(*) AS count FROM memory_candidate_source_refs",
      ).get())["count"]).toBe(2);
      expect(record(database.authority.db.prepare(
        "SELECT COUNT(*) AS count FROM memory_candidate_authority_claims",
      ).get())["count"]).toBe(1);
      expect(record(database.authority.db.prepare("SELECT COUNT(*) AS count FROM memory_outbox").get())["count"]).toBe(0);
    } finally {
      closeMemoryDatabase(database);
    }
  });

  it("rolls back a terminal-policy race loser while the signed winner consumes authority", async () => {
    const database = await memoryDatabase();
    try {
      const terminal = verifiedMemoryInput({
        authority_id: "conflicting-terminal-race",
        payload_fields: ["summary", "raw_body"],
      });
      const losing = structuredClone(terminal);
      losing["idempotency_key"] = "candidate:task27:conflicting-terminal-race-mutated";
      losing["statement"] = "A conflicting caller mutation cannot inherit verifier authority.";
      seedMemoryVerification(database.authority, terminal);
      const before = memoryTableCounts(database.authority);

      const results = await race(database.path, [terminal, losing]);

      expect(results.map(result => result.ok).sort()).toEqual([false, true]);
      expect(results.filter(result => result.ok).map(result => result.state)).toEqual(["rejected"]);
      expect(results.filter(result => !result.ok).map(result => result.code)).toEqual([
        "MEMORY_CANDIDATE_AUTHORITY_INVALID",
      ]);
      expect(record(database.authority.db.prepare(
        "SELECT COUNT(*) AS count FROM memory_candidates WHERE state='approved'",
      ).get())["count"]).toBe(0);
      expect(record(database.authority.db.prepare(
        "SELECT COUNT(*) AS count FROM memory_candidates WHERE state='rejected'",
      ).get())["count"]).toBe(1);
      const after = memoryTableCounts(database.authority);
      const expected: Readonly<Record<string, number>> = {
        memory_candidates: 1,
        memory_candidate_classifications: 1,
        memory_candidate_idempotency: 1,
        memory_candidate_source_refs: 2,
        personal_operation_audit_events: 1,
        memory_candidate_authority_claims: 1,
      };
      for (const [table, count] of Object.entries(after)) {
        expect(count - (before[table] ?? 0), table).toBe(expected[table] ?? 0);
      }
    } finally {
      closeMemoryDatabase(database);
    }
  });
});
