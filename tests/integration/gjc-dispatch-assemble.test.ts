import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeGjcCommand } from "../../src/cli-gjc-commands.js";
import { RecordingModelTransport } from "../../src/index.js";
import { gjcWorkerId } from "../../src/gjc-intent-store.js";
import { gjcTaskFor, seedGjcDispatch } from "../fixtures/gjc-dispatch-fixture.js";
import { contextAssemblerInput, CONTEXT_NOW } from "../fixtures/context-assembler-input.js";
import { assemblePersonalContext, JarvisError } from "../../src/index.js";
import { MemoryReferenceProvider, REFERENCE_NOW } from "../fixtures/memory-reference-provider.js";
import { closeMemoryDatabase, memoryDatabase } from "../fixtures/memory-candidate-store.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";


async function gjcProduct() {
  const database = await memoryDatabase();
  const db = database.authority;
  db.configureGjc(process.cwd(), "s", true);
  const source = seedGjcDispatch(db);
  const { config } = memoryReadFenceFixture(database, "2026-12-01T00:00:00.000Z");
  const provider = new MemoryReferenceProvider();
  return { database, db, source, config, provider };
}

function writeJson(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "gjc-dispatch-"));
  const path = join(dir, "task.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("gjc.dispatch assemble envelope", () => {
  it("does not send when extra keys sit on the exact-key task", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const task = { ...gjcTaskFor(db, source, "extra-keys"), assemble_context: contextAssemblerInput() };
    const transport = new RecordingModelTransport();
    await expect(executeGjcCommand({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson(task), fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => REFERENCE_NOW, memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport, transport: provider, read_fence_config: config } },
    } as never)).rejects.toMatchObject({ code: "GJC_DISPATCH_SCHEMA_INVALID" });
    expect(transport.sent).toHaveLength(0);
    closeMemoryDatabase(database);
  });

  it("sends once from a nested envelope after schema and auth pass", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const input = contextAssemblerInput();
    for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
      db.persistObservation(observation, CONTEXT_NOW);
    }
    const snapshot = assemblePersonalContext(input);
    const memory = snapshot.evidence.find(item => item.kind === "confirmed_memory");
    if (memory === undefined) throw new Error("memory");
    const transport = new RecordingModelTransport();
    const result = await executeGjcCommand({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson({
        task: gjcTaskFor(db, source, "envelope-ok"),
        assemble_context: input,
        memory_evidence: [{
          memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
          evidence_id: memory.evidence_id,
          source_id: memory.source_id,
          digest: memory.digest,
          observed_at: memory.observed_at,
          fresh_until: snapshot.expires_at,
        }],
      }),
      fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => REFERENCE_NOW, memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport, transport: provider, read_fence_config: config } },
    } as never);
    expect(result).toMatchObject({ ok: true, command: "gjc.dispatch" });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.session_id).toBe("s");
    expect(transport.sent[0]?.json).toContain("공통 기억");
    closeMemoryDatabase(database);
  });

  it("does not send a duplicate idempotency key", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const task = gjcTaskFor(db, source, "dup-key");
    db.createGjcDispatchFromTask(task);
    const transport = new RecordingModelTransport();
    const result = await executeGjcCommand({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson({ task, assemble_context: contextAssemblerInput() }),
      fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => REFERENCE_NOW, memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport, transport: provider, read_fence_config: config } },
    } as never);
    expect(result).toMatchObject({ ok: true, duplicate: true });
    expect(transport.sent).toHaveLength(0);
    closeMemoryDatabase(database);
  });

  it("does not send when production read_fence_config is unavailable", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const transport = new RecordingModelTransport();
    await expect(executeGjcCommand({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson({ task: gjcTaskFor(db, source, "fence-config"), assemble_context: contextAssemblerInput() }),
      fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: {
        clock: () => REFERENCE_NOW,
        memoryReferenceOptions: {
          projection_key: Buffer.alloc(32, 7),
          model_transport: transport,
          read_fence_config: {
            provider_instance_id: "provider:test",
            signing_key_id: "key:revoked",
            private_key_path: "/tmp/missing-memory-key.pem",
          },
        },
      },
    } as never)).rejects.toBeTruthy();
    expect(transport.sent).toHaveLength(0);
    closeMemoryDatabase(database);
  });

  it("sends once when two nested dispatches share an idempotency key", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const input = contextAssemblerInput();
    for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
      db.persistObservation(observation, CONTEXT_NOW);
    }
    const snapshot = assemblePersonalContext(input);
    const memory = snapshot.evidence.find(item => item.kind === "confirmed_memory");
    if (memory === undefined) throw new Error("memory");
    const transport = new RecordingModelTransport();
    const envelope = {
      task: gjcTaskFor(db, source, "concurrent-key"),
      assemble_context: input,
      memory_evidence: [{
        memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
        evidence_id: memory.evidence_id,
        source_id: memory.source_id,
        digest: memory.digest,
        observed_at: memory.observed_at,
        fresh_until: snapshot.expires_at,
      }],
    };
    const run = () => executeGjcCommand({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson(envelope), fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => REFERENCE_NOW, memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport, transport: provider, read_fence_config: config } },
    } as never);
    const [first, second] = await Promise.all([run(), run()]);
    expect(first?.intent_id).toBe(second?.intent_id);
    expect(transport.sent).toHaveLength(1);
    closeMemoryDatabase(database);
  });

  it("sends after a denied fence is later allowed", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const input = contextAssemblerInput();
    for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
      db.persistObservation(observation, CONTEXT_NOW);
    }
    const snapshot = assemblePersonalContext(input);
    const memory = snapshot.evidence.find(item => item.kind === "confirmed_memory");
    if (memory === undefined) throw new Error("memory");
    const transport = new RecordingModelTransport();
    const envelope = {
      task: gjcTaskFor(db, source, "deny-then-allow"),
      assemble_context: input,
      memory_evidence: [{
        memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
        evidence_id: memory.evidence_id,
        source_id: memory.source_id,
        digest: memory.digest,
        observed_at: memory.observed_at,
        fresh_until: snapshot.expires_at,
      }],
    };
    let deny = true;
    const ctx = (more: Record<string, unknown> = {}) => ({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson(envelope), fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: {
        clock: () => REFERENCE_NOW,
        memoryReferenceOptions: {
          projection_key: Buffer.alloc(32, 7), model_transport: transport,
          transport: provider, read_fence_config: config,
          read_fence: () => { if (deny) throw new Error("deny fence"); },
          ...more,
        },
      },
    } as never);
    await expect(executeGjcCommand(ctx())).rejects.toThrow(/deny fence/);
    expect(transport.sent).toHaveLength(0);
    deny = false;
    const result = await executeGjcCommand(ctx());
    expect(result).toMatchObject({ ok: true, command: "gjc.dispatch" });
    expect(result?.duplicate).not.toBe(true);
    expect(transport.sent).toHaveLength(1);
    closeMemoryDatabase(database);
  });

  it("sends after a failed transport is replaced", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const input = contextAssemblerInput();
    for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
      db.persistObservation(observation, CONTEXT_NOW);
    }
    const snapshot = assemblePersonalContext(input);
    const memory = snapshot.evidence.find(item => item.kind === "confirmed_memory");
    if (memory === undefined) throw new Error("memory");
    const failing = { sent: [] as unknown[], async send(capture: unknown) { this.sent.push(capture); return { accepted: false, reason: "unavailable" }; } };
    const ok = new RecordingModelTransport();
    const envelope = {
      task: gjcTaskFor(db, source, "fail-then-send"),
      assemble_context: input,
      memory_evidence: [{
        memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
        evidence_id: memory.evidence_id,
        source_id: memory.source_id,
        digest: memory.digest,
        observed_at: memory.observed_at,
        fresh_until: snapshot.expires_at,
      }],
    };
    const ctx = (transport: unknown) => ({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson(envelope), fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => REFERENCE_NOW, memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport, transport: provider, read_fence_config: config } },
    } as never);
    await expect(executeGjcCommand(ctx(failing))).rejects.toMatchObject({ code: "MODEL_TRANSPORT_UNAVAILABLE" });
    expect(failing.sent).toHaveLength(2);
    const result = await executeGjcCommand(ctx(ok));
    expect(result).toMatchObject({ ok: true, command: "gjc.dispatch" });
    expect(result?.duplicate).not.toBe(true);
    expect(ok.sent).toHaveLength(1);
    closeMemoryDatabase(database);
  });

  it("reclaims a dead-worker reservation on the public dispatch path", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const input = contextAssemblerInput();
    for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
      db.persistObservation(observation, CONTEXT_NOW);
    }
    const snapshot = assemblePersonalContext(input);
    const memory = snapshot.evidence.find(item => item.kind === "confirmed_memory");
    if (memory === undefined) throw new Error("memory");
    const task = gjcTaskFor(db, source, "dead-worker");
    db.reserveGjcDispatchFromTask(task, CONTEXT_NOW);
    db.db.prepare("UPDATE gjc_intents SET lease_owner='pid:2147483647' WHERE idempotency_key=?").run("dead-worker");
    const transport = new RecordingModelTransport();
    const result = await executeGjcCommand({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson({
        task,
        assemble_context: input,
        memory_evidence: [{
          memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
          evidence_id: memory.evidence_id,
          source_id: memory.source_id,
          digest: memory.digest,
          observed_at: memory.observed_at,
          fresh_until: snapshot.expires_at,
        }],
      }),
      fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => REFERENCE_NOW, memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport, transport: provider, read_fence_config: config } },
    } as never);
    expect(result).toMatchObject({ ok: true, command: "gjc.dispatch" });
    expect(result?.duplicate).not.toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(db.gjcIntentHasEvent(String(result?.intent_id), "model_dispatched")).toBe(true);
    expect(db.db.prepare("SELECT lease_owner FROM gjc_intents WHERE idempotency_key=?").get("dead-worker")).toEqual({ lease_owner: gjcWorkerId() });
    closeMemoryDatabase(database);
  });

  it("does not steal a living worker lease when the clock passes expiry", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const input = contextAssemblerInput();
    for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
      db.persistObservation(observation, CONTEXT_NOW);
    }
    const snapshot = assemblePersonalContext(input);
    const memory = snapshot.evidence.find(item => item.kind === "confirmed_memory");
    if (memory === undefined) throw new Error("memory");
    const task = gjcTaskFor(db, source, "live-expiry");
    db.reserveGjcDispatchFromTask(task, REFERENCE_NOW.toISOString());
    const transport = new RecordingModelTransport();
    const later = new Date(REFERENCE_NOW.getTime() + 61_000).toISOString();
    const result = await executeGjcCommand({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson({
        task,
        assemble_context: input,
        memory_evidence: [{
          memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
          evidence_id: memory.evidence_id,
          source_id: memory.source_id,
          digest: memory.digest,
          observed_at: memory.observed_at,
          fresh_until: snapshot.expires_at,
        }],
      }),
      fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => new Date(later), memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport, transport: provider, read_fence_config: config } },
    } as never);
    expect(result).toMatchObject({ ok: true, duplicate: true });
    expect(transport.sent).toHaveLength(0);
    closeMemoryDatabase(database);
  });

  it("does not resend when send started and local receipt is missing", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const input = contextAssemblerInput();
    for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
      db.persistObservation(observation, CONTEXT_NOW);
    }
    const snapshot = assemblePersonalContext(input);
    const memory = snapshot.evidence.find(item => item.kind === "confirmed_memory");
    if (memory === undefined) throw new Error("memory");
    const task = gjcTaskFor(db, source, "unknown-accepted");
    const reserved = db.reserveGjcDispatchFromTask(task, CONTEXT_NOW);
    db.recordGjcSendStarted(reserved.intent_id, reserved.intent_id, CONTEXT_NOW, reserved.lease_fence);
    db.db.prepare("UPDATE gjc_intents SET lease_owner='pid:2147483647' WHERE idempotency_key=?").run("unknown-accepted");
    const transport = new RecordingModelTransport();
    const result = await executeGjcCommand({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson({
        task,
        assemble_context: input,
        memory_evidence: [{
          memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
          evidence_id: memory.evidence_id,
          source_id: memory.source_id,
          digest: memory.digest,
          observed_at: memory.observed_at,
          fresh_until: snapshot.expires_at,
        }],
      }),
      fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => REFERENCE_NOW, memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport, transport: provider, read_fence_config: config } },
    } as never);
    expect(result).toMatchObject({ ok: true, recovered: "unknown_accepted" });
    expect(transport.sent).toHaveLength(0);
    closeMemoryDatabase(database);
  });

  it("does not treat a later unknown attempt as unlocked by an earlier failure", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const input = contextAssemblerInput();
    for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
      db.persistObservation(observation, CONTEXT_NOW);
    }
    const snapshot = assemblePersonalContext(input);
    const memory = snapshot.evidence.find(item => item.kind === "confirmed_memory");
    if (memory === undefined) throw new Error("memory");
    const task = gjcTaskFor(db, source, "fail-then-unknown");
    const envelope = {
      task,
      assemble_context: input,
      memory_evidence: [{
        memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
        evidence_id: memory.evidence_id,
        source_id: memory.source_id,
        digest: memory.digest,
        observed_at: memory.observed_at,
        fresh_until: snapshot.expires_at,
      }],
    };
    const failing = { sent: [] as unknown[], async send(capture: unknown) { this.sent.push(capture); return { accepted: false, reason: "unavailable" }; } };
    const ctx = (transport: unknown) => ({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson(envelope), fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => REFERENCE_NOW, memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport, transport: provider, read_fence_config: config } },
    } as never);
    await expect(executeGjcCommand(ctx(failing))).rejects.toMatchObject({ code: "MODEL_TRANSPORT_UNAVAILABLE" });
    const reserved = db.reserveGjcDispatchFromTask(task, CONTEXT_NOW);
    db.recordGjcSendStarted(reserved.intent_id, reserved.intent_id, CONTEXT_NOW, reserved.lease_fence);
    db.db.prepare("UPDATE gjc_intents SET lease_owner='pid:2147483647' WHERE idempotency_key=?").run("fail-then-unknown");
    const transport = new RecordingModelTransport();
    const result = await executeGjcCommand(ctx(transport));
    expect(result).toMatchObject({ ok: true, recovered: "unknown_accepted" });
    expect(transport.sent).toHaveLength(0);
    closeMemoryDatabase(database);
  });

  it("records a reconciled receipt even when the reserving worker is dead", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const input = contextAssemblerInput();
    for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
      db.persistObservation(observation, CONTEXT_NOW);
    }
    const snapshot = assemblePersonalContext(input);
    const memory = snapshot.evidence.find(item => item.kind === "confirmed_memory");
    if (memory === undefined) throw new Error("memory");
    const task = gjcTaskFor(db, source, "reconcile-dead");
    const reserved = db.reserveGjcDispatchFromTask(task, CONTEXT_NOW);
    db.recordGjcSendStarted(reserved.intent_id, reserved.intent_id, CONTEXT_NOW, reserved.lease_fence);
    db.db.prepare("UPDATE gjc_intents SET lease_owner='pid:2147483647' WHERE idempotency_key=?").run("reconcile-dead");
    const transport = {
      sent: [] as unknown[],
      async send(capture: unknown) { this.sent.push(capture); return { accepted: true }; },
      async reconcile() { return { accepted: true }; },
    };
    const result = await executeGjcCommand({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson({
        task,
        assemble_context: input,
        memory_evidence: [{
          memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
          evidence_id: memory.evidence_id,
          source_id: memory.source_id,
          digest: memory.digest,
          observed_at: memory.observed_at,
          fresh_until: snapshot.expires_at,
        }],
      }),
      fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => REFERENCE_NOW, memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport, transport: provider, read_fence_config: config } },
    } as never);
    expect(result).toMatchObject({ ok: true, recovered: "remote_accepted" });
    expect(transport.sent).toHaveLength(0);
    expect(db.gjcIntentHasEvent(reserved.intent_id, "model_dispatched")).toBe(true);
    closeMemoryDatabase(database);
  });

  it("does not resend after a disconnect thrown following remote acceptance", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const input = contextAssemblerInput();
    for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
      db.persistObservation(observation, CONTEXT_NOW);
    }
    const snapshot = assemblePersonalContext(input);
    const memory = snapshot.evidence.find(item => item.kind === "confirmed_memory");
    if (memory === undefined) throw new Error("memory");
    const task = gjcTaskFor(db, source, "disconnect-unknown");
    const envelope = {
      task,
      assemble_context: input,
      memory_evidence: [{
        memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
        evidence_id: memory.evidence_id,
        source_id: memory.source_id,
        digest: memory.digest,
        observed_at: memory.observed_at,
        fresh_until: snapshot.expires_at,
      }],
    };
    let sends = 0;
    const transport = {
      async send() {
        sends += 1;
        throw Object.assign(new Error("ECONNRESET after remote acceptance"), { retryable: true });
      },
    };
    const ctx = {
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson(envelope), fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => REFERENCE_NOW, memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport, transport: provider, read_fence_config: config } },
    } as never;
    await expect(executeGjcCommand(ctx)).rejects.toThrow(/ECONNRESET/);
    const retry = new RecordingModelTransport();
    const result = await executeGjcCommand({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson(envelope), fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => REFERENCE_NOW, memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: retry, transport: provider, read_fence_config: config } },
    } as never);
    expect(sends).toBe(1);
    expect(retry.sent).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, recovered: "unknown_accepted" });
    closeMemoryDatabase(database);
  });

  it("sends after a pre-send fence deny is corrected", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const input = contextAssemblerInput();
    for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
      db.persistObservation(observation, CONTEXT_NOW);
    }
    const snapshot = assemblePersonalContext(input);
    const memory = snapshot.evidence.find(item => item.kind === "confirmed_memory");
    if (memory === undefined) throw new Error("memory");
    const task = gjcTaskFor(db, source, "presend-deny");
    const envelope = {
      task,
      assemble_context: input,
      memory_evidence: [{
        memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
        evidence_id: memory.evidence_id,
        source_id: memory.source_id,
        digest: memory.digest,
        observed_at: memory.observed_at,
        fresh_until: snapshot.expires_at,
      }],
    };
    let fences = 0;
    let phase = 0;
    const transport = new RecordingModelTransport();
    const ctx = {
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson(envelope), fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: {
        clock: () => REFERENCE_NOW,
        memoryReferenceOptions: {
          projection_key: Buffer.alloc(32, 7),
          model_transport: transport,
          transport: provider, read_fence_config: config,
          read_fence: () => {
            fences += 1;
            if (phase === 0 && fences >= 2) throw new JarvisError("CURRENT_READER_DENIED");
          },
        },
      },
    } as never;
    await expect(executeGjcCommand(ctx)).rejects.toThrow(/CURRENT_READER_DENIED/);
    expect(transport.sent).toHaveLength(0);
    phase = 1;
    const result = await executeGjcCommand({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson(envelope), fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: {
        clock: () => REFERENCE_NOW,
        memoryReferenceOptions: {
          projection_key: Buffer.alloc(32, 7),
          model_transport: transport,
          transport: provider, read_fence_config: config,
          read_fence: () => {
            fences += 1;
            if (phase === 0 && fences >= 2) throw new JarvisError("CURRENT_READER_DENIED");
          },
        },
      },
    } as never);
    expect(result).toMatchObject({ ok: true });
    expect(transport.sent).toHaveLength(1);
    closeMemoryDatabase(database);
  });

  it("resends after a known-negative then retry-fence deny is corrected", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const input = contextAssemblerInput();
    for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
      db.persistObservation(observation, CONTEXT_NOW);
    }
    const snapshot = assemblePersonalContext(input);
    const memory = snapshot.evidence.find(item => item.kind === "confirmed_memory");
    if (memory === undefined) throw new Error("memory");
    const task = gjcTaskFor(db, source, "negative-then-deny");
    const envelope = {
      task,
      assemble_context: input,
      memory_evidence: [{
        memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
        evidence_id: memory.evidence_id,
        source_id: memory.source_id,
        digest: memory.digest,
        observed_at: memory.observed_at,
        fresh_until: snapshot.expires_at,
      }],
    };
    let fences = 0;
    let phase = 0;
    const transport = {
      sent: [] as unknown[],
      async send(capture: unknown) {
        this.sent.push(capture);
        return { accepted: phase !== 0 };
      },
    };
    const options = () => ({
      projection_key: Buffer.alloc(32, 7),
      model_transport: transport,
      transport: provider, read_fence_config: config,
      read_fence: () => {
        fences += 1;
        if (phase === 0 && fences >= 3) throw new JarvisError("CURRENT_READER_DENIED");
      },
    });
    const ctx = () => ({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson(envelope), fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => REFERENCE_NOW, memoryReferenceOptions: options() },
    } as never);
    await expect(executeGjcCommand(ctx())).rejects.toThrow(/CURRENT_READER_DENIED/);
    expect(transport.sent).toHaveLength(1);
    phase = 1;
    const result = await executeGjcCommand(ctx());
    expect(result).toMatchObject({ ok: true });
    expect(transport.sent).toHaveLength(2);
    closeMemoryDatabase(database);
  });

  it("does not resend after an inner negative then accepted crash", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const input = contextAssemblerInput();
    for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
      db.persistObservation(observation, CONTEXT_NOW);
    }
    const snapshot = assemblePersonalContext(input);
    const memory = snapshot.evidence.find(item => item.kind === "confirmed_memory");
    if (memory === undefined) throw new Error("memory");
    const task = gjcTaskFor(db, source, "inner-negative-crash");
    const envelope = {
      task,
      assemble_context: input,
      memory_evidence: [{
        memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
        evidence_id: memory.evidence_id,
        source_id: memory.source_id,
        digest: memory.digest,
        observed_at: memory.observed_at,
        fresh_until: snapshot.expires_at,
      }],
    };
    let attempts = 0;
    const crashing = {
      async send() {
        attempts += 1;
        if (attempts === 1) return { accepted: false, reason: "explicit negative" };
        throw Object.assign(new Error("ECONNRESET after remote acceptance"), { retryable: true });
      },
    };
    const ctx = (transport: unknown) => ({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson(envelope), fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => REFERENCE_NOW, memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport, transport: provider, read_fence_config: config } },
    } as never);
    await expect(executeGjcCommand(ctx(crashing))).rejects.toThrow(/ECONNRESET/);
    const retry = new RecordingModelTransport();
    const result = await executeGjcCommand(ctx(retry));
    expect(attempts).toBe(2);
    expect(retry.sent).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, recovered: "unknown_accepted" });
    closeMemoryDatabase(database);
  });
});
