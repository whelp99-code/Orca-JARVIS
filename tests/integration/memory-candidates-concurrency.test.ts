import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import {
  memoryPolicy,
  MEMORY_NOW,
  verifiedMemoryInput,
} from "../fixtures/memory-candidate-fixture.js";

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

async function race(path: string, input: unknown): Promise<readonly RaceResult[]> {
  const workers = [0, 1].map(() => new Worker(raceWorker, {
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
    const root = mkdtempSync(join(tmpdir(), "jarvis-task27-race-"));
    const path = join(root, "authority.sqlite");
    const authority = new AuthorityDb(path);
    try {
      await authority.migrate();

      // When: both workers announce readiness before the same candidate is released.
      const results = await race(path, verifiedMemoryInput());

      // Then: both return one byte-identical canonical result and no duplicate audit state exists.
      expect(results.every(result => result.ok)).toBe(true);
      expect(new Set(results.map(result => result.candidate_id)).size).toBe(1);
      expect(new Set(results.map(result => result.classification_digest)).size).toBe(1);
      expect(results.map(result => result.state)).toEqual(["approved", "approved"]);
      for (const table of ["memory_candidates", "memory_candidate_classifications", "memory_candidate_idempotency",
        "personal_operation_audit_events"]) {
        expect(record(authority.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())["count"], table).toBe(1);
      }
      expect(record(authority.db.prepare(
        "SELECT COUNT(*) AS count FROM memory_candidate_source_refs",
      ).get())["count"]).toBe(2);
      expect(record(authority.db.prepare("SELECT COUNT(*) AS count FROM memory_outbox").get())["count"]).toBe(0);
    } finally {
      authority.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
