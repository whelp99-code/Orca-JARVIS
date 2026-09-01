import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import type { JarvisMemoryBarrierId } from "../../src/memory-lifecycle-barriers.js";
import { tempDb } from "../helpers.js";

const BARRIERS = [
  { ordinal: 5, id: "jarvis_suppression_tombstone_commit" },
  { ordinal: 25, id: "jarvis_proof_observation" },
  { ordinal: 26, id: "before_settlement_commit" },
] as const satisfies readonly { readonly ordinal: number; readonly id: JarvisMemoryBarrierId }[];

type WorkerInput = {
  readonly database: string;
  readonly barrier: JarvisMemoryBarrierId;
  readonly mode: "hold" | "recover";
};

async function runWorker(input: WorkerInput): Promise<{
  readonly event: Readonly<Record<string, unknown>>;
  readonly exit: readonly unknown[];
}> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [
    join(process.cwd(), "tests/fixtures/memory-barrier-worker.mjs"),
    input.database, input.barrier, input.mode,
  ]);
  const lines = createInterface({ input: child.stdout });
  const output = once(lines, "line", { signal: AbortSignal.timeout(5_000) });
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  child.stdin.write("GO\n");
  try {
    const values = await output;
    const event = record(JSON.parse(String(values[0])));
    if (input.mode === "hold") child.kill("SIGKILL");
    const exit = await exited;
    return { event, exit };
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MEMORY_BARRIER_WORKER_OUTPUT_INVALID");
  }
  return Object.fromEntries(Object.entries(value));
}

describe("external JARVIS memory barrier crash recovery", () => {
  it.each(BARRIERS)("kills and restarts a real worker at barrier $ordinal", async barrier => {
    // Given: one migrated authority database and a worker blocked on the exact durable barrier event.
    const path = tempDb();
    const seed = new AuthorityDb(path);
    await seed.migrate();
    seed.close();
    try {
      // When: the parent kills the first process after its event, then starts one recovery process.
      const crashed = await runWorker({ database: path, barrier: barrier.id, mode: "hold" });
      const recovered = await runWorker({ database: path, barrier: barrier.id, mode: "recover" });

      // Then: replay returns the same event and only one durable barrier row exists.
      const db = new AuthorityDb(path);
      try {
        expect({ crashed: crashed.event, crashed_exit: crashed.exit,
          recovered: recovered.event, recovered_exit: recovered.exit,
          rows: db.db.prepare(
            "SELECT barrier_id,COUNT(*) AS count FROM memory_lifecycle_barrier_events GROUP BY barrier_id",
          ).all() }).toEqual({
          crashed: recovered.event, crashed_exit: [null, "SIGKILL"],
          recovered: recovered.event, recovered_exit: [0, null],
          rows: [{ barrier_id: barrier.id, count: 1 }],
        });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  }, 20_000);
});
