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
import { createHash } from "node:crypto";
import { canonicalize } from "../../src/canonical.js";
import { MemoryReferenceProvider, REFERENCE_NOW, REFERENCE_RECORD } from "../fixtures/memory-reference-provider.js";
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
    const { database, db, source } = await gjcProduct();
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
    const failing = { sent: [] as unknown[], async send(capture: unknown) { this.sent.push(capture); return { accepted: false, reason: "unavailable", failure_class: "explicit_negative" }; } };
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
    const failing = { sent: [] as unknown[], async send(capture: unknown) { this.sent.push(capture); return { accepted: false, reason: "unavailable", failure_class: "explicit_negative" }; } };
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
        if (attempts === 1) return { accepted: false, reason: "explicit negative", failure_class: "explicit_negative" };
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

  it("binds each selected record to its own memory_ref", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const second = boundRecord("A distinct second memory", "87654321");
    useRecords(provider, [REFERENCE_RECORD, second]);
    const transport = new RecordingModelTransport();
    const result = await executeGjcCommand(readerDispatch(db, source, config, provider, transport, "two-records"));
    expect(result).toMatchObject({ ok: true, command: "gjc.dispatch" });
    expect(transport.sent).toHaveLength(1);
    const request = transport.sent[0]?.request;
    expect(request?.memories.map(item => item.memory_ref).sort()).toEqual(["12345678", "87654321"]);
    expect(new Set(request?.memories.map(item => item.source_id)).size).toBe(2);
    closeMemoryDatabase(database);
  });

  it("binds distinct records that share body and source to different evidence", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    useRecords(provider, [REFERENCE_RECORD, sameContentRecord("87654321")]);
    const transport = new RecordingModelTransport();
    const result = await executeGjcCommand(readerDispatch(db, source, config, provider, transport, "same-content"));
    expect(result).toMatchObject({ ok: true, command: "gjc.dispatch" });
    expect(transport.sent[0]?.request.memories.map(item => item.memory_ref).sort()).toEqual(["12345678", "87654321"]);
    const bindings = db.db.prepare("SELECT memory_ref, evidence_id FROM personal_context_memory_evidence").all() as Array<{ memory_ref: string; evidence_id: string }>;
    expect(bindings.map(row => row.memory_ref).sort()).toEqual(["12345678", "87654321"]);
    expect(new Set(bindings.map(row => row.evidence_id)).size).toBe(2);
    closeMemoryDatabase(database);
  });

  it("keeps same-source different-body records on separate lineages", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    useRecords(provider, [REFERENCE_RECORD, sameSourceRecord("Other body from the same source", "87654321")]);
    const transport = new RecordingModelTransport();
    const result = await executeGjcCommand(readerDispatch(db, source, config, provider, transport, "same-source"));
    expect(result).toMatchObject({ ok: true });
    const memories = transport.sent[0]?.request.memories ?? [];
    expect(memories.map(item => item.memory_ref).sort()).toEqual(["12345678", "87654321"]);
    expect(new Set(memories.map(item => item.version)).size).toBe(2);
    expect(new Set(memories.map(item => item.source_id)).size).toBe(1);
    closeMemoryDatabase(database);
  });

  it("preserves reader excerpt budget and source instead of rewriting them", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const body = `Important ${"content ".repeat(25)}END_CRITICAL_SOURCE_DETAIL`;
    useRecords(provider, [boundRecord(body, "87654321")]);
    const transport = new RecordingModelTransport();
    const assemble = {
      ...readerAssemble(),
      budgets: { max_items: 16, max_excerpt_bytes: 4_096, max_total_bytes: 4_096 },
    };
    const result = await executeGjcCommand(readerDispatch(db, source, config, provider, transport, "long-text", assemble));
    expect(result).toMatchObject({ ok: true });
    const memory = transport.sent[0]?.request.memories[0];
    expect(memory?.excerpt).toContain("END_CRITICAL_SOURCE_DETAIL");
    expect(memory?.source_id).not.toBe("src:pos:v1:second-brain:inbox");
    expect(memory?.excerpt.length ?? 0).toBeGreaterThan(96);
    closeMemoryDatabase(database);
  });

  it("limits final JSON and excerpt bytes to the assemble budgets", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const body = `Important ${"content ".repeat(200)}END_CRITICAL_SOURCE_DETAIL`;
    useRecords(provider, [boundRecord(body, "87654321")]);
    const transport = new RecordingModelTransport();
    const assemble = {
      ...readerAssemble(),
      budgets: { max_items: 16, max_excerpt_bytes: 128, max_total_bytes: 2_048 },
    };
    const result = await executeGjcCommand(readerDispatch(db, source, config, provider, transport, "budget-2048", assemble));
    expect(result).toMatchObject({ ok: true });
    expect(transport.sent).toHaveLength(1);
    const capture = transport.sent[0];
    expect(capture?.bytes ?? 0).toBeLessThanOrEqual(2_048);
    expect(Buffer.byteLength(capture?.json ?? "", "utf8")).toBeLessThanOrEqual(2_048);
    for (const memory of capture?.request.memories ?? []) {
      expect(memory.bytes).toBeLessThanOrEqual(128);
      expect(Buffer.byteLength(memory.excerpt, "utf8")).toBeLessThanOrEqual(128);
    }
    closeMemoryDatabase(database);
  });

  it("persists the same selected memories that the transport sends", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const second = boundRecord("A distinct second memory", "87654321");
    useRecords(provider, [REFERENCE_RECORD, second]);
    const transport = new RecordingModelTransport();
    await executeGjcCommand(readerDispatch(db, source, config, provider, transport, "lineage"));
    const snapshot = db.db.prepare(
      "SELECT memory_count, evidence_count FROM personal_context_snapshots ORDER BY rowid DESC LIMIT 1",
    ).get() as { memory_count: number; evidence_count: number } | undefined;
    const bindings = db.db.prepare("SELECT memory_ref FROM personal_context_memory_evidence").all() as Array<{ memory_ref: string }>;
    expect(snapshot?.memory_count).toBe(2);
    expect(bindings.map(row => row.memory_ref).sort()).toEqual(["12345678", "87654321"]);
    expect(db.lastAssembledModelCapture()?.request.memories).toEqual(transport.sent[0]?.request.memories);
    expect(db.lastAssembledModelCapture()?.no_data).toBe(false);
    closeMemoryDatabase(database);
  });

  it("sends after a before-send generation refusal is corrected", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    let phase = 0;
    const original = provider.call.bind(provider);
    provider.call = async (method, args) => {
      const out = await original(method, args);
      if (phase === 0 && method === "sb_generation_status" && out.kind === "data"
        && provider.calls.filter(call => call.method === "sb_generation_status").length >= 3) {
        return { kind: "data" as const, value: { ...out.value, generation_id: `sbgen:v1:${"2".repeat(64)}` } };
      }
      return out;
    };
    const transport = new RecordingModelTransport();
    await expect(executeGjcCommand(readerDispatch(db, source, config, provider, transport, "before-send-gen")))
      .rejects.toMatchObject({ code: "MEMORY_REFERENCE_GENERATION_CHANGED" });
    expect(transport.sent).toHaveLength(0);
    phase = 1;
    const result = await executeGjcCommand(readerDispatch(db, source, config, provider, transport, "before-send-gen"));
    expect(result).toMatchObject({ ok: true, command: "gjc.dispatch" });
    expect(result).not.toMatchObject({ recovered: "unknown_accepted" });
    expect(transport.sent).toHaveLength(1);
    closeMemoryDatabase(database);
  });

  it("does not resend a stale selection after a known-negative generation change", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    let sends = 0;
    const transport = {
      sent: [] as unknown[],
      async send(capture: unknown) {
        this.sent.push(capture);
        sends += 1;
        if (sends === 1) {
          provider.statusOverrides = { generation_id: `sbgen:v1:${"2".repeat(64)}` };
          return { accepted: false, reason: "synthetic-negative", failure_class: "explicit_negative" };
        }
        return { accepted: true };
      },
    };
    await expect(executeGjcCommand(readerDispatch(db, source, config, provider, transport, "gen-changed")))
      .rejects.toMatchObject({ code: "MEMORY_REFERENCE_GENERATION_CHANGED" });
    expect(sends).toBe(1);
    closeMemoryDatabase(database);
  });

  it("does not assemble when model_transport is missing", async () => {
    const { database, db, source, config, provider } = await gjcProduct();
    const input = contextAssemblerInput();
    await expect(executeGjcCommand({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson({ task: gjcTaskFor(db, source, "no-transport"), assemble_context: input, memory_evidence: [] }),
      fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => REFERENCE_NOW, memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), transport: provider, read_fence_config: config } },
    } as never)).rejects.toMatchObject({ code: "MEMORY_MODEL_TRANSPORT_REQUIRED" });
    closeMemoryDatabase(database);
  });
});

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sameContentRecord(sid: string) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-sibling omission of the identity fields
  const { record_id: _id, record_digest: _digest, ...core } = REFERENCE_RECORD;
  const next = { ...core, sid };
  const recordDigest = digestText(`second-brain/memory-record/v1\0${canonicalize(next)}`);
  return { ...next, record_id: `sbrecord:v1:${recordDigest.slice(7)}`, record_digest: recordDigest };
}

function sameSourceRecord(text: string, sid: string) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-sibling omission of the identity fields
  const { record_id: _id, record_digest: _digest, ...core } = REFERENCE_RECORD;
  const next = {
    ...core,
    sid,
    record_text: text,
    record_text_digest: digestText(text),
    citation_span_end: Buffer.byteLength(text),
    content_identity_full: digestText(text).slice(7),
    origin_label: REFERENCE_RECORD.origin_label,
  };
  const recordDigest = digestText(`second-brain/memory-record/v1\0${canonicalize(next)}`);
  return { ...next, record_id: `sbrecord:v1:${recordDigest.slice(7)}`, record_digest: recordDigest };
}

function boundRecord(text: string, sid: string) {
  const core = {
    schema_version: REFERENCE_RECORD.schema_version,
    sid,
    record_text: text,
    record_text_digest: digestText(text),
    citation_span_start: REFERENCE_RECORD.citation_span_start,
    citation_span_end: Buffer.byteLength(text),
    source_identity_full: digestText(sid).slice(7),
    content_identity_full: digestText(text).slice(7),
    citation_identity_full: REFERENCE_RECORD.citation_identity_full,
    sensitivity: REFERENCE_RECORD.sensitivity,
    source_owner_class: REFERENCE_RECORD.source_owner_class,
    source_owner_id_digest: REFERENCE_RECORD.source_owner_id_digest,
    origin_label: `different-source:${sid}`,
    valid_from: REFERENCE_RECORD.valid_from,
    valid_until: REFERENCE_RECORD.valid_until,
  };
  const recordDigest = digestText(`second-brain/memory-record/v1\0${canonicalize(core)}`);
  return { ...core, record_id: `sbrecord:v1:${recordDigest.slice(7)}`, record_digest: recordDigest };
}

function useRecords(provider: MemoryReferenceProvider, records: ReadonlyArray<typeof REFERENCE_RECORD>): void {
  const original = provider.call.bind(provider);
  provider.call = async (method, args) => {
    const out = await original(method, args);
    if (out.kind !== "data") return out;
    if (method === "sb_read_page") {
      return { kind: "data" as const, value: { ...out.value, records } };
    }
    if (method === "sb_search") {
      return {
        kind: "data" as const,
        value: {
          ...out.value,
          results: records.map(record => ({
            page_id: "wiki/reference", section: "Memory", snippet: record.record_text, score: 1,
            record_id: record.record_id, record_digest: record.record_digest,
          })),
        },
      };
    }
    return out;
  };
}

function readerAssemble() {
  const input = contextAssemblerInput();
  return { ...input, query: "current memory", observations: [], memories: [] };
}

function readerDispatch(
  db: Awaited<ReturnType<typeof gjcProduct>>["db"],
  source: ReturnType<typeof seedGjcDispatch>,
  config: Awaited<ReturnType<typeof gjcProduct>>["config"],
  provider: MemoryReferenceProvider,
  transport: unknown,
  key: string,
  assemble: ReturnType<typeof readerAssemble> = readerAssemble(),
) {
  return {
    args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
    argument: writeJson({
      task: gjcTaskFor(db, source, key),
      assemble_context: assemble,
      memory_evidence: [],
    }),
    fourth: undefined, fifth: undefined, sixth: undefined, db,
    dependencies: {
      clock: () => REFERENCE_NOW,
      memoryReferenceOptions: {
        projection_key: Buffer.alloc(32, 7),
        model_transport: transport,
        transport: provider,
        read_fence_config: config,
      },
    },
  } as never;
}
