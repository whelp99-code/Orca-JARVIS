import { unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { z } from "zod";
import type { Database } from "better-sqlite3";
import { applyCycleId } from "./personal-os-cycle-cursor.js";
import { PersonalOsError, assertNever } from "./personal-os-errors.js";

export const PERSONAL_OS_CONTROL_CHANNEL_ENV = "PERSONAL_OS_CONTROL_CHANNEL" as const;

const RequestedSchema = z.object({ type: z.literal("cycle_requested"), id: z.number().int().positive() });
const CompletedSchema = z.object({ type: z.literal("cycle_completed"), id: z.number().int().positive() });
const ShutdownSchema = z.object({ type: z.literal("shutdown") });
const ClientIncomingSchema = z.discriminatedUnion("type", [CompletedSchema]);
const ServerIncomingSchema = z.discriminatedUnion("type", [RequestedSchema, ShutdownSchema]);

export async function withWatchdog<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  const abort = new Promise<never>((_, reject) => {
    const fail = (): void => {
      reject(new PersonalOsError("E_PROCESS_STRESS"));
    };
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  return Promise.race([promise, abort]);
}

function writeLine(socket: Socket, value: object): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

export function ensureCycleCursor(db: Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS personal_os_cycle_cursor ("
    + "k INTEGER PRIMARY KEY CHECK (k = 1), last_completed INTEGER NOT NULL, applied_count INTEGER NOT NULL)",
  );
  db.prepare("INSERT OR IGNORE INTO personal_os_cycle_cursor(k, last_completed, applied_count) VALUES (1, 0, 0)").run();
}

export function readCycleCursor(db: Database): { readonly last_completed: number; readonly applied_count: number } {
  const row: unknown = db.prepare("SELECT last_completed, applied_count FROM personal_os_cycle_cursor WHERE k = 1").get();
  if (typeof row !== "object" || row === null) throw new PersonalOsError("E_CYCLE_PROTOCOL");
  if (!("last_completed" in row) || !("applied_count" in row)) throw new PersonalOsError("E_CYCLE_PROTOCOL");
  if (typeof row.last_completed !== "number" || typeof row.applied_count !== "number") {
    throw new PersonalOsError("E_CYCLE_PROTOCOL");
  }
  return { last_completed: row.last_completed, applied_count: row.applied_count };
}

function applyRequested(db: Database, id: number): void {
  const tx = db.transaction((cycleId: number) => {
    const cursor = readCycleCursor(db);
    const result = applyCycleId(cursor.last_completed, cycleId);
    switch (result.kind) {
      case "applied":
        db.prepare("UPDATE personal_os_cycle_cursor SET last_completed = ?, applied_count = applied_count + 1 WHERE k = 1").run(
          result.id,
        );
        return;
      case "duplicate":
        return;
      case "rejected":
        throw new PersonalOsError("E_CYCLE_PROTOCOL");
      default: {
        assertNever(result);
      }
    }
  });
  tx(id);
}

function consumeLines(buffer: string, chunk: string, onLine: (line: string) => void): string {
  const combined = buffer + chunk;
  const parts = combined.split("\n");
  const rest = parts.pop();
  for (const line of parts) {
    if (line.length > 0) onLine(line);
  }
  return rest ?? "";
}

export async function servePersonalOsCycleChannel(input: {
  readonly db: Database;
  readonly socketPath: string;
}): Promise<void> {
  ensureCycleCursor(input.db);
  try {
    unlinkSync(input.socketPath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.socketPath, () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    server.on("connection", (socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer = consumeLines(buffer, chunk.toString("utf8"), (line) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch (error) {
            if (error instanceof SyntaxError) throw new PersonalOsError("E_CYCLE_PROTOCOL");
            throw error;
          }
          const message = ServerIncomingSchema.parse(parsed);
          switch (message.type) {
            case "cycle_requested":
              applyRequested(input.db, message.id);
              writeLine(socket, { type: "cycle_completed", id: message.id });
              return;
            case "shutdown":
              socket.end();
              server.close();
              resolve();
              return;
            default: {
              assertNever(message);
            }
          }
        });
      });
      socket.on("error", reject);
    });
  });
  try {
    unlinkSync(input.socketPath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

export class PersonalOsCycleClient {
  private buffer = "";
  private readonly pending = new Map<number, () => void>();

  constructor(private readonly socket: Socket) {
    this.socket.on("data", (chunk) => {
      this.buffer = consumeLines(this.buffer, chunk.toString("utf8"), (line) => {
        const message = ClientIncomingSchema.parse(JSON.parse(line));
        const resolve = this.pending.get(message.id);
        if (resolve !== undefined) {
          this.pending.delete(message.id);
          resolve();
        }
      });
    });
  }

  subscribe(id: number): Promise<void> {
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
    });
  }

  sendRequested(id: number): void {
    writeLine(this.socket, { type: "cycle_requested", id });
  }

  sendShutdown(): void {
    writeLine(this.socket, { type: "shutdown" });
  }

  async request(id: number, watchdogMs: number): Promise<void> {
    const completed = this.subscribe(id);
    this.sendRequested(id);
    await withWatchdog(completed, watchdogMs);
  }

  close(): void {
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve();
    }
    this.socket.destroy();
  }
}

export function connectCycleClient(socketPath: string): Promise<PersonalOsCycleClient> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolve(new PersonalOsCycleClient(socket)));
    socket.once("error", reject);
  });
}
