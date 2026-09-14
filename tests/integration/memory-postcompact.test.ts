import { afterEach, describe, expect, it } from "vitest";
import { hostMemoryReferenceOptions } from "../../src/cli-host-memory.js";
import { executeMemoryPostcompact } from "../../src/cli-gjc-commands.js";
import { execute } from "../../src/cli-runtime.mjs";
import { CommandModelTransport, RecordingModelTransport, type ModelTransport, type ModelTransportCapture, type ModelTransportResult } from "../../src/index.js";
import { MemoryReferenceProvider, REFERENCE_NOW, REFERENCE_RECORD } from "../fixtures/memory-reference-provider.js";
import { closeMemoryDatabase, memoryDatabase } from "../fixtures/memory-candidate-store.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";

class SequenceTransport implements ModelTransport {
  readonly sent: ModelTransportCapture[] = [];
  constructor(private readonly replies: ModelTransportResult[]) {}
  async send(capture: ModelTransportCapture): Promise<ModelTransportResult> {
    this.sent.push(capture);
    return this.replies[this.sent.length - 1] ?? { accepted: false, reason: "exhausted", failure_class: "explicit_negative" };
  }
}

type CapturingTransport = ModelTransport & { readonly sent: ModelTransportCapture[] };

async function ready(model_transport?: CapturingTransport) {
  const database = await memoryDatabase();
  const { config } = memoryReadFenceFixture(database, "2026-12-01T00:00:00.000Z");
  const provider = new MemoryReferenceProvider();
  const transport: CapturingTransport = model_transport ?? new RecordingModelTransport();
  const context = {
    args: [],
    values: {},
    positionals: [],
    command: "memory",
    subcommand: "postcompact",
    argument: undefined,
    fourth: undefined,
    fifth: undefined,
    sixth: undefined,
    db: database.authority,
    dependencies: {
      clock: () => REFERENCE_NOW,
      readStdin: async () => Buffer.from(JSON.stringify({
        hook_event_name: "PostCompact",
        session_id: "claude-sess-1",
        compact_summary: "공통 기억",
        trigger: "auto",
        prompt_id: "p1",
        compaction_id: "c1",
      })),
      memoryReferenceOptions: {
        projection_key: Buffer.alloc(32, 7),
        model_transport: transport,
        transport: provider,
        read_fence_config: config,
      },
    },
  };
  return { database, transport, context };
}

describe("memory.postcompact configured transport", () => {
  it("reselects and sends body, source, and budget on a configured transport", async () => {
    const { database, transport, context } = await ready();
    const result = await executeMemoryPostcompact(context as never);
    expect(result).toMatchObject({ ok: true, command: "memory.postcompact", transport: "configured" });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.session_id).toBe("claude-sess-1");
    expect(transport.sent[0]?.json).toContain("공통 기억");
    expect(transport.sent[0]?.request.budgets).toEqual({
      max_items: 8,
      max_excerpt_bytes: 4096,
      max_total_bytes: 16384,
    });
    expect(transport.sent[0]?.request.memories[0]?.source_id).toBeTruthy();
    expect(transport.sent[0]?.request.memories[0]?.version).toBe(REFERENCE_RECORD.record_digest);
    closeMemoryDatabase(database);
  });

  it("does not default to Recording when model_transport is missing", async () => {
    const { database, context } = await ready();
    const options = context.dependencies.memoryReferenceOptions;
    const stripped = {
      ...context,
      dependencies: {
        ...context.dependencies,
        memoryReferenceOptions: {
          projection_key: options.projection_key,
          transport: options.transport,
          read_fence_config: options.read_fence_config,
        },
      },
    };
    await expect(executeMemoryPostcompact(stripped as never)).rejects.toMatchObject({
      code: "MEMORY_MODEL_TRANSPORT_REQUIRED",
    });
    closeMemoryDatabase(database);
  });

  it("rejects PreCompact instead of sending", async () => {
    const { database, transport, context } = await ready();
    const blocked = {
      ...context,
      dependencies: {
        ...context.dependencies,
        readStdin: async () => Buffer.from(JSON.stringify({
          hook_event_name: "PreCompact",
          session_id: "claude-sess-1",
          compact_summary: "공통 기억",
        })),
      },
    };
    await expect(executeMemoryPostcompact(blocked as never)).rejects.toMatchObject({
      code: "HOOK_EVENT_UNSUPPORTED",
    });
    expect(transport.sent).toHaveLength(0);
    closeMemoryDatabase(database);
  });

  it("retries a known-negative then succeeds on configured transport", async () => {
    const sequence = new SequenceTransport([
      { accepted: false, reason: "synthetic unavailable", failure_class: "explicit_negative" },
      { accepted: true },
    ]);
    const { database, context } = await ready(sequence);
    const result = await executeMemoryPostcompact(context as never);
    expect(result).toMatchObject({ ok: true, transport: "configured" });
    expect(sequence.sent).toHaveLength(2);
    closeMemoryDatabase(database);
  });

  it("does not report success when transport stays unavailable", async () => {
    const sequence = new SequenceTransport([
      { accepted: false, reason: "synthetic unavailable", failure_class: "explicit_negative" },
      { accepted: false, reason: "synthetic unavailable", failure_class: "explicit_negative" },
    ]);
    const { database, context } = await ready(sequence);
    await expect(executeMemoryPostcompact(context as never)).rejects.toMatchObject({
      code: "MODEL_TRANSPORT_UNAVAILABLE",
    });
    expect(sequence.sent).toHaveLength(2);
    closeMemoryDatabase(database);
  });

  it("does not resend the same event digest", async () => {
    const { database, transport, context } = await ready();
    const first = await executeMemoryPostcompact(context as never);
    const second = await executeMemoryPostcompact(context as never);
    expect(first.duplicate).not.toBe(true);
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(transport.sent).toHaveLength(1);
    closeMemoryDatabase(database);
  });

  it("sends again for a new compaction query", async () => {
    const { database, transport, context } = await ready();
    await executeMemoryPostcompact(context as never);
    const next = {
      ...context,
      dependencies: {
        ...context.dependencies,
        readStdin: async () => Buffer.from(JSON.stringify({
          hook_event_name: "PostCompact",
          session_id: "claude-sess-1",
          compact_summary: "기억",
          trigger: "auto",
        })),
      },
    };
    const result = await executeMemoryPostcompact(next as never);
    expect(result.duplicate).not.toBe(true);
    expect(transport.sent).toHaveLength(2);
    closeMemoryDatabase(database);
  });

  it("sends again when the same summary has a new prompt_id", async () => {
    const { database, transport, context } = await ready();
    await executeMemoryPostcompact(context as never);
    const next = {
      ...context,
      dependencies: {
        ...context.dependencies,
        readStdin: async () => Buffer.from(JSON.stringify({
          hook_event_name: "PostCompact",
          session_id: "claude-sess-1",
          compact_summary: "공통 기억",
          trigger: "auto",
          prompt_id: "p2",
        })),
      },
    };
    const result = await executeMemoryPostcompact(next as never);
    expect(result.duplicate).not.toBe(true);
    expect(transport.sent).toHaveLength(2);
    closeMemoryDatabase(database);
  });

  it("sends again when prompt_id is the same and compaction_id changes", async () => {
    const { database, transport, context } = await ready();
    await executeMemoryPostcompact(context as never);
    const next = {
      ...context,
      dependencies: {
        ...context.dependencies,
        readStdin: async () => Buffer.from(JSON.stringify({
          hook_event_name: "PostCompact",
          session_id: "claude-sess-1",
          compact_summary: "공통 기억",
          trigger: "auto",
          prompt_id: "p1",
          compaction_id: "c2",
        })),
      },
    };
    const result = await executeMemoryPostcompact(next as never);
    expect(result.duplicate).not.toBe(true);
    expect(transport.sent).toHaveLength(2);
    closeMemoryDatabase(database);
  });
});

describe("memory.postcompact host composition", () => {
  afterEach(() => {
    delete process.env["JARVIS_MODEL_TRANSPORT_CMD"];
    delete process.env["JARVIS_MODEL_TRANSPORT_ARGS"];
  });

  it("accepts only when the consumer command exits 0", async () => {
    const database = await memoryDatabase();
    const { config } = memoryReadFenceFixture(database, "2026-12-01T00:00:00.000Z");
    process.env["JARVIS_MODEL_TRANSPORT_CMD"] = process.execPath;
    process.env["JARVIS_MODEL_TRANSPORT_ARGS"] = JSON.stringify([
      "-e",
      "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.exit(s.includes('session_id')?0:1))",
    ]);
    const host = hostMemoryReferenceOptions();
    expect(host?.model_transport).toBeInstanceOf(CommandModelTransport);
    const result = await execute(["memory", "postcompact", "--db", database.path], {
      clock: () => REFERENCE_NOW,
      readStdin: async () => Buffer.from(JSON.stringify({
        hook_event_name: "PostCompact",
        session_id: "claude-sess-1",
        compact_summary: "공통 기억",
        trigger: "auto",
        prompt_id: "p1",
      })),
      memoryReferenceOptions: {
        ...host,
        projection_key: Buffer.alloc(32, 7),
        transport: new MemoryReferenceProvider(),
        read_fence_config: config,
      },
    });
    expect(result).toMatchObject({ ok: true, command: "memory.postcompact", transport: "configured" });
    closeMemoryDatabase(database);
  });
});
