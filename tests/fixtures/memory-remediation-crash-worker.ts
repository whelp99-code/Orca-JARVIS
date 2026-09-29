import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { AuthorityDb } from "../../src/db.js";
import { AuthorityDatabaseRuntime } from "../../src/authority-database-runtime.js";
import { MemoryAuthorityCompactor } from "../../src/memory-authority-compactor.js";
import { MemoryManagedSurfaceScanner } from "../../src/memory-managed-surface-scanner.js";
import { MemoryLifecycleBarriers } from "../../src/memory-lifecycle-barriers.js";
import { MemoryCorrectionSaga } from "../../src/memory-correction-saga.js";
import { MemoryDeletionSaga } from "../../src/memory-deletion-saga.js";
import { ProductionMemoryLifecycleService } from "../../src/memory-lifecycle-service.js";
import { executeControlCommand } from "../../src/cli-control-commands.js";
import { SecondBrainEffectService } from "../../src/second-brain-effect-service.js";
import { requireMemoryEffectWriteRequest } from "../../src/second-brain-effect-v2.js";
import type { MemorySagaRuntime } from "../../src/memory-saga-runtime.js";
import { createSecondBrainWriteRequestAdapter } from "../../src/second-brain-write-adapter.js";
import type { SecondBrainTransport } from "../../src/second-brain-transport.js";
import { correctionPreparedFixture, correctionObservation } from "./memory-correction-control.js";
import { deletionPreparedFixture, deletionObservation } from "./memory-deletion-recovery.js";
import { withProvableExclusion } from "./provable-exclusion.js";
import { noopMemoryBarriers } from "./memory-lifecycle-runtime.js";

const laneSchema = z.enum(["correction", "deletion"]);
const barrierSchema = z.enum(["jarvis_suppression_tombstone_commit", "before_settlement_commit", "provider_accepted_before_local_persistence"]);
const descriptorSchema = z.object({ database: z.string(), root: z.string(), anchors: z.string(), database_root: z.string(),
  lane: laneSchema, barrier: barrierSchema, request_id: z.string(), status: z.enum(["pending", "proved"]) });
const at = new Date("2026-08-28T12:00:00.000Z");
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"),
  Buffer.from(Array.from({ length: 32 }, (_, i) => i))]), format: "der", type: "pkcs8" });
const journalSchema = z.object({ frames: z.number().int(), effects: z.array(z.string()), requests: z.array(z.unknown()),
  status_reads: z.number().int().default(0) });

function syntheticProvider(root: string, db: AuthorityDb,
  mode: { readonly hold: boolean; readonly status: "pending" | "proved" }) {
  const path = join(root, "synthetic-provider.json");
  const journal = journalSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const calls = journal.requests.map(request => requireMemoryEffectWriteRequest(request,
    { now: at, expectedProvider: "provider:fixture", delegationKeys: new Map([["jarvis:fixture", createPublicKey(privateKey)]]) }));
  const persist = () => writeFileSync(path, JSON.stringify({ ...journal, requests: calls }), { mode: 0o600 });
  const transport: SecondBrainTransport = { async call(method, args) {
    if (method === "sb_request_status") {
      journal.status_reads += 1; persist();
      return { kind: "data", value: { schema_version: 1, request_id: args.request_id, state: mode.status } };
    }
    if (method !== "sb_write_request") throw new Error("UNEXPECTED_PROVIDER_METHOD");
    const request = requireMemoryEffectWriteRequest(args.request, { now: at, expectedProvider: "provider:fixture",
      delegationKeys: new Map([["jarvis:fixture", createPublicKey(privateKey)]]) });
    journal.frames += 1;
    if (!calls.some(prior => prior.request_id === request.request_id)) calls.push(request);
    if (!journal.effects.includes(request.idempotency_key)) journal.effects.push(request.idempotency_key);
    persist();
    if (mode.hold) {
      process.stdout.write(`${JSON.stringify({ kind: "barrier", barrier_id: "provider_accepted_before_local_persistence",
        request_id: request.request_id, frames: journal.frames, effects: journal.effects.length })}\n`);
      await new Promise<void>(() => { /* exact external acceptance event; supervisor SIGKILLs the caller */ });
    }
    return { kind: "data", value: { schema_version: 2, kind: "accepted", state: "pending", request_id: request.request_id,
      request_digest: request.request_digest, envelope_digest: request.envelope_digest, idempotency_key: request.idempotency_key,
      lane: request.lane, operation: request.operation, accepted_at: at.toISOString(), queue_locator: `pending/${request.request_id}.v2.json`,
      request_file_digest: `sha256:${"1".repeat(64)}`, replayed: false, capability_verified: true,
      tombstone_sequence: request.tombstone_high_water.sequence, tombstone_set_root: request.tombstone_high_water.set_root,
      provider_instance_id: request.provider_instance_id } };
  }, restart: async () => undefined, close: async () => undefined, diagnostics: () => [] };
  const writer = createSecondBrainWriteRequestAdapter(transport, db, () => at);
  return { writer, calls, transport, journal };
}

function observationRuntime(runtime: MemorySagaRuntime, provider: ReturnType<typeof syntheticProvider>): MemorySagaRuntime {
  return { ...runtime, writer: provider.writer, observer: {
    correction: async record => {
      const status = await provider.transport.call("sb_request_status", { request_id: record.request_id });
      if (status.kind !== "data" || status.value.state !== "proved") return { kind: "not_proved", code: "PROVIDER_PENDING" };
      return correctionObservation({ db: runtime.authority, writer: { calls: provider.calls }, record });
    },
    deletion: async record => {
      if (record.request_id === null) throw new Error("DELETION_REQUEST_MISSING");
      const status = await provider.transport.call("sb_request_status", { request_id: record.request_id });
      if (status.kind !== "data" || status.value.state !== "proved") return { kind: "not_proved", code: "PROVIDER_PENDING" };
      return deletionObservation({ db: runtime.authority, runtime, writer: { calls: provider.calls } }, record);
    },
    export: async () => ({ kind: "not_proved", code: "UNUSED" }),
  } };
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const descriptorPath = z.string().parse(process.argv[3]);
  if (mode === "hold") {
    const lane = laneSchema.parse(process.argv[4]);
    const barrier = barrierSchema.parse(process.argv[5]);
    const f = await (lane === "correction" ? correctionPreparedFixture() : deletionPreparedFixture());
    writeFileSync(join(f.root, "synthetic-provider.json"), JSON.stringify({ frames: 0, effects: [], requests: [] }), { mode: 0o600 });
    const descriptor = { database: f.db.filename, root: f.root, database_root: f.database.root,
      anchors: f.database.anchorsRoot, lane, barrier, request_id: f.action.request_id,
      status: z.enum(["pending", "proved"]).parse(process.argv[6] ?? "proved") };
    writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
    const provider = syntheticProvider(f.root, f.db, { hold: barrier === "provider_accepted_before_local_persistence", status: "proved" });
    const runtime = observationRuntime({ ...f.runtime, barriers: new MemoryLifecycleBarriers(f.db, {
      async reached(event) {
        if (event.barrier_id !== barrier) return;
        process.stdout.write(`${JSON.stringify({ kind: "barrier", ...event })}\n`);
        await new Promise<void>(() => { /* parent kills this process at the exact durable barrier */ });
      },
    }) }, provider);
    const saga = lane === "correction" ? new MemoryCorrectionSaga(runtime) : new MemoryDeletionSaga(runtime);
    const record = await saga.dispatch(f.claim);
    const id = "correction_id" in record ? record.correction_id : record.deletion_id;
    await saga.reconcile(id);
    throw new Error("CRASH_BARRIER_NOT_REACHED");
  }
  if (mode !== "recover") throw new Error("MODE_INVALID");
  const descriptor = descriptorSchema.parse(JSON.parse(readFileSync(descriptorPath, "utf8")));
  const db = new AuthorityDb(descriptor.database);
  const layout = { spool_root: join(descriptor.root, "spool"), state_root: join(descriptor.root, "state"),
    dist_root: join(descriptor.root, "dist"), backup_root: join(descriptor.root, "backups"), restore_root: join(descriptor.root, "restore") };
  const databaseRuntime = new AuthorityDatabaseRuntime(db, { registry_root: join(descriptor.root, "registry"), watchdog_ms: 5000 });
  withProvableExclusion(databaseRuntime);
  const synthetic = syntheticProvider(descriptor.root, db, { hold: false, status: descriptor.status });
  const compactor = new MemoryAuthorityCompactor({ runtime: databaseRuntime,
    scanner: new MemoryManagedSurfaceScanner({ authority: db, layout }), layout, clock: () => at });
  const recovered: string[] = [];
  const transport = { call: async () => { throw new Error("UNEXPECTED_PROVIDER_CALL"); },
    restart: async () => undefined, close: async () => undefined, diagnostics: () => [] };
  const provider = new SecondBrainEffectService({ authority: db, transport, writer: synthetic.writer,
    clock: () => at, provider_instance_id: "provider:fixture", signing_key_id: "jarvis:fixture", private_key: privateKey });
  const runtime = observationRuntime({ authority: db, spool_root: layout.spool_root, writer: synthetic.writer, provider,
    signing_key_id: "jarvis:fixture", private_key: privateKey, subject_key: Buffer.alloc(32, 3), clock: () => at,
    observer: { correction: async () => ({ kind: "not_proved", code: "UNUSED" }),
      deletion: async () => ({ kind: "not_proved", code: "UNUSED" }), export: async () => ({ kind: "not_proved", code: "UNUSED" }) },
    compactor: { compact: request => compactor.compact(request), recover: purgeId => {
      recovered.push(purgeId); return compactor.recover(purgeId);
    } }, barriers: noopMemoryBarriers(db) }, synthetic);
  const lifecycle = new ProductionMemoryLifecycleService(runtime, () => databaseRuntime.close());
  try {
    // Drive the built CLI command handler, with the run-owned authority and provider composition.
    const context = { args: ["memory", "lifecycle", "--once"], positionals: ["memory", "lifecycle"],
      command: "memory", subcommand: "lifecycle", argument: undefined, fourth: undefined,
      fifth: undefined, sixth: undefined, values: { once: true }, db, dependencies: { memoryLifecycle: lifecycle, clock: () => at } };
    const result = await executeControlCommand(context);
    await executeControlCommand(context);
    const table = descriptor.lane === "correction" ? "memory_correction_requests" : "memory_deletion_effect_requests";
    const rows = db.db.prepare(`SELECT state,request_id,request_digest,envelope_digest,delegation_id,delegation_digest,
      expires_at,dispatch_fence,tombstone_sequence FROM ${table}`).all();
    const count = (sql: string) => z.object({ count: z.number() }).parse(db.db.prepare(sql).get()).count;
    process.stdout.write(`${JSON.stringify({ kind: "recovered", result, rows, recovered,
      tombstones: count("SELECT count(*) AS count FROM memory_tombstone_chain"),
      purges: count("SELECT count(*) AS count FROM memory_purge_jobs"),
      frames: synthetic.journal.frames, effects: synthetic.journal.effects.length,
      status_reads: synthetic.journal.status_reads,
      accepted_through: count("SELECT accepted_through_sequence AS count FROM memory_effect_dispatch_cursor"),
      reconciled_spools: count("SELECT count(*) AS count FROM memory_spool_cleanup_receipts WHERE disposition='status_reconciled'"),
      attempt_rows: count(`SELECT count(*) AS count FROM ${descriptor.lane === "correction" ? "memory_correction_attempts" : "memory_deletion_attempts"}`),
      original_request: synthetic.calls[0],
      effect_rows: db.db.prepare("SELECT count(*) AS count FROM control_command_effects WHERE request_id=?").get(descriptor.request_id),
      redemption_rows: db.db.prepare("SELECT count(*) AS count FROM control_command_redemptions WHERE request_id=?").get(descriptor.request_id),
    })}\n`);
  } finally { await lifecycle.close(); }
}
const lines = createInterface({ input: process.stdin });
lines.once("line", () => { void main().then(() => lines.close(), error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; lines.close();
}); });
