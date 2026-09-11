import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeGjcCommand } from "../../src/cli-gjc-commands.js";
import { RecordingModelTransport } from "../../src/index.js";
import { gjcWorkerId } from "../../src/gjc-intent-store.js";
import { gjcTaskFor, seedGjcDispatch } from "../fixtures/gjc-dispatch-fixture.js";
import { contextAssemblerInput, CONTEXT_NOW } from "../fixtures/context-assembler-input.js";
import { assemblePersonalContext } from "../../src/index.js";
import { initialized } from "../helpers.js";

function writeJson(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "gjc-dispatch-"));
  const path = join(dir, "task.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("gjc.dispatch assemble envelope", () => {
  it("does not send when extra keys sit on the exact-key task", async () => {
    const db = await initialized();
    db.configureGjc(process.cwd(), "s", true);
    const source = seedGjcDispatch(db);
    const task = { ...gjcTaskFor(db, source, "extra-keys"), assemble_context: contextAssemblerInput() };
    const transport = new RecordingModelTransport();
    await expect(executeGjcCommand({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson(task), fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => new Date(CONTEXT_NOW), memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport } },
    } as never)).rejects.toMatchObject({ code: "GJC_DISPATCH_SCHEMA_INVALID" });
    expect(transport.sent).toHaveLength(0);
    db.close();
  });

  it("sends once from a nested envelope after schema and auth pass", async () => {
    const db = await initialized();
    db.configureGjc(process.cwd(), "s", true);
    const source = seedGjcDispatch(db);
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
      dependencies: { clock: () => new Date(CONTEXT_NOW), memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport } },
    } as never);
    expect(result).toMatchObject({ ok: true, command: "gjc.dispatch" });
    expect(transport.sent).toHaveLength(1);
    db.close();
  });

  it("does not send a duplicate idempotency key", async () => {
    const db = await initialized();
    db.configureGjc(process.cwd(), "s", true);
    const source = seedGjcDispatch(db);
    const task = gjcTaskFor(db, source, "dup-key");
    db.createGjcDispatchFromTask(task);
    const transport = new RecordingModelTransport();
    const result = await executeGjcCommand({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson({ task, assemble_context: contextAssemblerInput() }),
      fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: { clock: () => new Date(CONTEXT_NOW), memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport } },
    } as never);
    expect(result).toMatchObject({ ok: true, duplicate: true });
    expect(transport.sent).toHaveLength(0);
    db.close();
  });

  it("does not send when production read_fence_config is unavailable", async () => {
    const db = await initialized();
    db.configureGjc(process.cwd(), "s", true);
    const source = seedGjcDispatch(db);
    const transport = new RecordingModelTransport();
    await expect(executeGjcCommand({
      args: [], values: {}, positionals: [], command: "gjc", subcommand: "dispatch",
      argument: writeJson({ task: gjcTaskFor(db, source, "fence-config"), assemble_context: contextAssemblerInput() }),
      fourth: undefined, fifth: undefined, sixth: undefined, db,
      dependencies: {
        clock: () => new Date(CONTEXT_NOW),
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
    db.close();
  });

  it("sends once when two nested dispatches share an idempotency key", async () => {
    const db = await initialized();
    db.configureGjc(process.cwd(), "s", true);
    const source = seedGjcDispatch(db);
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
      dependencies: { clock: () => new Date(CONTEXT_NOW), memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport } },
    } as never);
    const [first, second] = await Promise.all([run(), run()]);
    expect(first?.intent_id).toBe(second?.intent_id);
    expect(transport.sent).toHaveLength(1);
    db.close();
  });

  it("sends after a denied fence is later allowed", async () => {
    const db = await initialized();
    db.configureGjc(process.cwd(), "s", true);
    const source = seedGjcDispatch(db);
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
        clock: () => new Date(CONTEXT_NOW),
        memoryReferenceOptions: {
          projection_key: Buffer.alloc(32, 7), model_transport: transport,
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
    db.close();
  });

  it("sends after a failed transport is replaced", async () => {
    const db = await initialized();
    db.configureGjc(process.cwd(), "s", true);
    const source = seedGjcDispatch(db);
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
      dependencies: { clock: () => new Date(CONTEXT_NOW), memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport } },
    } as never);
    await expect(executeGjcCommand(ctx(failing))).rejects.toMatchObject({ code: "MODEL_TRANSPORT_UNAVAILABLE" });
    expect(failing.sent).toHaveLength(2);
    const result = await executeGjcCommand(ctx(ok));
    expect(result).toMatchObject({ ok: true, command: "gjc.dispatch" });
    expect(result?.duplicate).not.toBe(true);
    expect(ok.sent).toHaveLength(1);
    db.close();
  });

  it("reclaims a dead-worker reservation on the public dispatch path", async () => {
    const db = await initialized();
    db.configureGjc(process.cwd(), "s", true);
    const source = seedGjcDispatch(db);
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
      dependencies: { clock: () => new Date(CONTEXT_NOW), memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport } },
    } as never);
    expect(result).toMatchObject({ ok: true, command: "gjc.dispatch" });
    expect(result?.duplicate).not.toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(db.gjcIntentHasEvent(String(result?.intent_id), "model_dispatched")).toBe(true);
    expect(db.db.prepare("SELECT lease_owner FROM gjc_intents WHERE idempotency_key=?").get("dead-worker")).toEqual({ lease_owner: gjcWorkerId() });
    db.close();
  });

  it("does not steal a living worker lease when the clock passes expiry", async () => {
    const db = await initialized();
    db.configureGjc(process.cwd(), "s", true);
    const source = seedGjcDispatch(db);
    const input = contextAssemblerInput();
    for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
      db.persistObservation(observation, CONTEXT_NOW);
    }
    const snapshot = assemblePersonalContext(input);
    const memory = snapshot.evidence.find(item => item.kind === "confirmed_memory");
    if (memory === undefined) throw new Error("memory");
    const task = gjcTaskFor(db, source, "live-expiry");
    db.reserveGjcDispatchFromTask(task, CONTEXT_NOW);
    const transport = new RecordingModelTransport();
    const later = new Date(Date.parse(CONTEXT_NOW) + 61_000).toISOString();
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
      dependencies: { clock: () => new Date(later), memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport } },
    } as never);
    expect(result).toMatchObject({ ok: true, duplicate: true });
    expect(transport.sent).toHaveLength(0);
    db.close();
  });

  it("does not resend when send started and local receipt is missing", async () => {
    const db = await initialized();
    db.configureGjc(process.cwd(), "s", true);
    const source = seedGjcDispatch(db);
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
      dependencies: { clock: () => new Date(CONTEXT_NOW), memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport } },
    } as never);
    expect(result).toMatchObject({ ok: true, recovered: "unknown_accepted" });
    expect(transport.sent).toHaveLength(0);
    db.close();
  });

  it("does not treat a later unknown attempt as unlocked by an earlier failure", async () => {
    const db = await initialized();
    db.configureGjc(process.cwd(), "s", true);
    const source = seedGjcDispatch(db);
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
      dependencies: { clock: () => new Date(CONTEXT_NOW), memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport } },
    } as never);
    await expect(executeGjcCommand(ctx(failing))).rejects.toMatchObject({ code: "MODEL_TRANSPORT_UNAVAILABLE" });
    const reserved = db.reserveGjcDispatchFromTask(task, CONTEXT_NOW);
    db.recordGjcSendStarted(reserved.intent_id, reserved.intent_id, CONTEXT_NOW, reserved.lease_fence);
    db.db.prepare("UPDATE gjc_intents SET lease_owner='pid:2147483647' WHERE idempotency_key=?").run("fail-then-unknown");
    const transport = new RecordingModelTransport();
    const result = await executeGjcCommand(ctx(transport));
    expect(result).toMatchObject({ ok: true, recovered: "unknown_accepted" });
    expect(transport.sent).toHaveLength(0);
    db.close();
  });

  it("records a reconciled receipt even when the reserving worker is dead", async () => {
    const db = await initialized();
    db.configureGjc(process.cwd(), "s", true);
    const source = seedGjcDispatch(db);
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
      dependencies: { clock: () => new Date(CONTEXT_NOW), memoryReferenceOptions: { projection_key: Buffer.alloc(32, 7), model_transport: transport } },
    } as never);
    expect(result).toMatchObject({ ok: true, recovered: "remote_accepted" });
    expect(transport.sent).toHaveLength(0);
    expect(db.gjcIntentHasEvent(reserved.intent_id, "model_dispatched")).toBe(true);
    db.close();
  });
});
