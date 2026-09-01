import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { tempDb } from "../helpers.js";

const LANES = ["remember", "correction", "export", "forget"] as const;
type Channel = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: Interface;
  readonly exited: Promise<readonly unknown[]>;
};

type Message = {
  readonly kind: string;
  readonly lane?: string;
  readonly worker?: string;
  readonly effect_id?: string;
  readonly pid: number;
};

function processChannel(script: string, args: readonly string[]): Channel {
  const child = spawn(process.execPath, [join(process.cwd(), "tests", "fixtures", script), ...args]);
  return { child, lines: createInterface({ input: child.stdout }),
    exited: once(child, "exit", { signal: AbortSignal.timeout(30_000) }) };
}

async function command(channel: Channel, value: string): Promise<Message> {
  const output = once(channel.lines, "line", { signal: AbortSignal.timeout(10_000) });
  channel.child.stdin.write(`${value}\n`);
  const [line] = await output;
  return message(JSON.parse(String(line)));
}

function message(value: unknown): Message {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MEMORY_PROCESS_MESSAGE_INVALID");
  }
  const kind = Reflect.get(value, "kind");
  const pid = Reflect.get(value, "pid");
  const lane = Reflect.get(value, "lane");
  const worker = Reflect.get(value, "worker");
  const effectId = Reflect.get(value, "effect_id");
  if (typeof kind !== "string" || typeof pid !== "number"
    || (lane !== undefined && typeof lane !== "string")
    || (worker !== undefined && typeof worker !== "string")
    || (effectId !== undefined && typeof effectId !== "string")) {
    throw new Error("MEMORY_PROCESS_MESSAGE_INVALID");
  }
  return { kind, pid, ...(lane === undefined ? {} : { lane }),
    ...(worker === undefined ? {} : { worker }),
    ...(effectId === undefined ? {} : { effect_id: effectId }) };
}

function count(db: AuthorityDb, table: string): number {
  const value: unknown = db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  const observed = value !== null && typeof value === "object" ? Reflect.get(value, "count") : undefined;
  if (typeof observed !== "number") throw new Error("MEMORY_PROCESS_COUNT_INVALID");
  return observed;
}

describe("combined real-process memory topology", () => {
  it("runs 32 JARVIS workers across four lanes through two providers without duplicate effects", async () => {
    // Given: four durable lane fences, 32 armed JARVIS processes, and two armed provider processes.
    const database = tempDb();
    const seed = new AuthorityDb(database);
    await seed.migrate();
    seed.db.exec(`
      CREATE TABLE task30_harness_frames(lane TEXT PRIMARY KEY,worker TEXT NOT NULL,process_id INTEGER NOT NULL);
      CREATE TABLE task30_harness_claims(lane TEXT PRIMARY KEY,provider TEXT NOT NULL,process_id INTEGER NOT NULL);
      CREATE TABLE task30_harness_effects(lane TEXT PRIMARY KEY,effect_id TEXT NOT NULL UNIQUE,provider TEXT NOT NULL);
      CREATE TABLE task30_harness_settlements(lane TEXT PRIMARY KEY,effect_id TEXT NOT NULL UNIQUE,worker TEXT NOT NULL);
    `);
    seed.close();
    const workers = Array.from({ length: 32 }, (_, index) => processChannel(
      "memory-concurrency-jarvis-worker.mjs",
      [database, LANES[index % LANES.length] ?? "remember", `jarvis-${String(index + 1)}`],
    ));
    const providers = ["provider-a", "provider-b"].map(id => processChannel(
      "memory-concurrency-provider-worker.mjs", [database, id],
    ));
    const channels = [...workers, ...providers];
    try {
      await Promise.all(channels.map(channel => command(channel, "ARM")));

      // When: all JARVIS workers race once, winners flow to both providers, and effects return to settlement.
      const attempts = await Promise.all(workers.map(channel => command(channel, "GO")));
      const frames = attempts.filter(item => item.kind === "frame");
      const winnerByLane = new Map(frames.map(frame => [frame.lane, frame]));
      const effects: Message[] = [];
      for (let offset = 0; offset < LANES.length; offset += providers.length) {
        const batch = LANES.slice(offset, offset + providers.length);
        effects.push(...await Promise.all(batch.map((lane, index) => command(
          providers[index] ?? providers[0] ?? fail(), `PROCESS ${lane}`,
        ))));
      }
      const workerByPid = new Map(workers.map(channel => [channel.child.pid, channel]));
      const settlements = await Promise.all(effects.map(effect => {
        const winner = winnerByLane.get(effect.lane);
        const channel = winner === undefined ? undefined : workerByPid.get(winner.pid);
        if (channel === undefined || effect.effect_id === undefined) return Promise.reject(fail());
        return command(channel, `SETTLE ${effect.effect_id}`);
      }));
      await Promise.all(providers.map(channel => command(channel, "STOP")));
      await Promise.all(channels.map(channel => channel.exited));

      // Then: the real topology records exact 4/4/4/4 outcomes and no duplicate frame or effect.
      const db = new AuthorityDb(database);
      try {
        const frameRows = db.db.prepare(
          "SELECT lane,COUNT(*) AS count FROM task30_harness_frames GROUP BY lane ORDER BY lane",
        ).all();
        expect({ jarvis_processes: new Set(attempts.map(item => item.pid)).size,
          provider_processes: new Set(effects.map(item => item.pid)).size,
          frames: count(db, "task30_harness_frames"), claims: count(db, "task30_harness_claims"),
          effects: count(db, "task30_harness_effects"), settlements: count(db, "task30_harness_settlements"),
          duplicate_frames: frames.length - new Set(frames.map(item => item.lane)).size,
          duplicate_effects: effects.length - new Set(effects.map(item => item.effect_id)).size,
          settled_messages: settlements.length, lanes: frameRows,
        }).toEqual({ jarvis_processes: 32, provider_processes: 2, frames: 4, claims: 4,
          effects: 4, settlements: 4, duplicate_frames: 0, duplicate_effects: 0,
          settled_messages: 4, lanes: [
            { lane: "correction", count: 1 }, { lane: "export", count: 1 },
            { lane: "forget", count: 1 }, { lane: "remember", count: 1 },
          ] });
      } finally {
        db.close();
      }
    } finally {
      for (const channel of channels) {
        channel.lines.close();
        if (channel.child.exitCode === null && channel.child.signalCode === null) channel.child.kill("SIGKILL");
      }
      rmSync(dirname(database), { recursive: true, force: true });
    }
  }, 30_000);
});

function fail(): never {
  throw new Error("MEMORY_PROCESS_TOPOLOGY_INVALID");
}
