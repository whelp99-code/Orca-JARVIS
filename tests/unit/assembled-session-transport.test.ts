import { describe, expect, it } from "vitest";
import {
  assemblePersonalContext, AssembledModelSession, AuthorityDb, RecordingModelTransport,
  type ModelTransport, type ModelTransportCapture, type ModelTransportResult,
} from "../../src/index.js";
import { createProductionMemoryReference } from "../../src/memory-reference-production.js";
import { contextAssemblerInput, CONTEXT_NOW } from "../fixtures/context-assembler-input.js";
import { tempDb } from "../helpers.js";

class SequenceTransport implements ModelTransport {
  readonly sent: ModelTransportCapture[] = [];
  constructor(private readonly replies: ModelTransportResult[]) {}
  async send(capture: ModelTransportCapture): Promise<ModelTransportResult> {
    this.sent.push(capture);
    return this.replies[this.sent.length - 1] ?? { accepted: false, reason: "exhausted" };
  }
}

async function ready() {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  const input = contextAssemblerInput();
  for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
    db.persistObservation(observation, CONTEXT_NOW);
  }
  const snapshot = assemblePersonalContext(input);
  const memory = snapshot.evidence.find((item) => item.kind === "confirmed_memory");
  if (memory === undefined) throw new Error("confirmed memory required");
  const evidence = [{
    memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
    evidence_id: memory.evidence_id,
    source_id: memory.source_id,
    digest: memory.digest,
    observed_at: memory.observed_at,
    fresh_until: snapshot.expires_at,
  }];
  return { db, input, evidence };
}

describe("production assembled model session", () => {
  it("does not send when snapshot persist is rejected", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const transport = new RecordingModelTransport();
    const session = new AssembledModelSession(db, transport);
    await expect(session.deliver(contextAssemblerInput(), [], CONTEXT_NOW)).rejects.toThrow();
    expect(transport.sent).toHaveLength(0);
    db.close();
  });

  it("retries a failed transport send then delivers from the production factory", async () => {
    const { db, input, evidence } = await ready();
    const transport = new SequenceTransport([
      { accepted: false, reason: "synthetic unavailable" },
      { accepted: true },
    ]);
    const produced = createProductionMemoryReference(db, {
      projection_key: Buffer.alloc(32, 7),
      model_transport: transport,
      transport: { call: async () => undefined as never, close: async () => undefined } as never,
    });
    const delivered = await produced.deliverAssembled(input, evidence, CONTEXT_NOW);
    expect(delivered.capture.json).toContain("Prioritize confirmed customer");
    expect(delivered.capture.json).toContain("src:pos:v1:second-brain:primary");
    expect(transport.sent).toHaveLength(2);
    db.close();
  });

  it("throws when transport stays unavailable after retry", async () => {
    const { db, input, evidence } = await ready();
    const transport = new SequenceTransport([
      { accepted: false, reason: "synthetic unavailable" },
      { accepted: false, reason: "synthetic unavailable" },
    ]);
    const session = new AssembledModelSession(db, transport);
    await expect(session.deliver(input, evidence, CONTEXT_NOW)).rejects.toMatchObject({ code: "MODEL_TRANSPORT_UNAVAILABLE" });
    expect(transport.sent).toHaveLength(2);
    db.close();
  });

  it("does not send when the production read fence denies", async () => {
    const { db, input, evidence } = await ready();
    const transport = new RecordingModelTransport();
    let fenceCalls = 0;
    const produced = createProductionMemoryReference(db, {
      projection_key: Buffer.alloc(32, 7),
      model_transport: transport,
      read_fence: () => { fenceCalls += 1; throw new Error("deny fence"); },
      transport: { call: async () => undefined as never, close: async () => undefined } as never,
    });
    await expect(produced.deliverAssembled(input, evidence, CONTEXT_NOW)).rejects.toThrow(/deny fence/);
    expect(fenceCalls).toBe(1);
    expect(transport.sent).toHaveLength(0);
    db.close();
  });

  it("does not convert a thrown disconnect into a known-negative retry", async () => {
    const { db, input, evidence } = await ready();
    const transport: ModelTransport & { sent: ModelTransportCapture[] } = {
      sent: [],
      async send(capture) {
        this.sent.push(capture);
        throw Object.assign(new Error("ECONNRESET after remote acceptance"), { retryable: true });
      },
    };
    const session = new AssembledModelSession(db, transport);
    await expect(session.deliver(input, evidence, CONTEXT_NOW)).rejects.toThrow(/ECONNRESET/);
    expect(transport.sent).toHaveLength(1);
    db.close();
  });

  it("re-authorizes before retry so a mid-flight revoke does not send twice", async () => {
    const { db, input, evidence } = await ready();
    let authorizes = 0;
    const transport = new SequenceTransport([{ accepted: false, reason: "unavailable" }, { accepted: true }]);
    const session = new AssembledModelSession(db, transport, () => {
      authorizes += 1;
      if (authorizes === 2) throw new Error("revoked after first send");
    });
    await expect(session.deliver(input, evidence, CONTEXT_NOW)).rejects.toThrow(/revoked after first send/);
    expect(transport.sent).toHaveLength(1);
    db.close();
  });
});
