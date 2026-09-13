import { describe, expect, it } from "vitest";
import { executeMemoryPostcompact } from "../../src/cli-gjc-commands.js";
import { RecordingModelTransport, type ModelTransport, type ModelTransportCapture, type ModelTransportResult } from "../../src/index.js";
import { MemoryReferenceProvider, REFERENCE_NOW } from "../fixtures/memory-reference-provider.js";
import { closeMemoryDatabase, memoryDatabase } from "../fixtures/memory-candidate-store.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";

class SequenceTransport implements ModelTransport {
  readonly sent: ModelTransportCapture[] = [];
  constructor(private readonly replies: ModelTransportResult[]) {}
  async send(capture: ModelTransportCapture): Promise<ModelTransportResult> {
    this.sent.push(capture);
    return this.replies[this.sent.length - 1] ?? { accepted: false, reason: "exhausted" };
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
      { accepted: false, reason: "synthetic unavailable" },
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
      { accepted: false, reason: "synthetic unavailable" },
      { accepted: false, reason: "synthetic unavailable" },
    ]);
    const { database, context } = await ready(sequence);
    await expect(executeMemoryPostcompact(context as never)).rejects.toMatchObject({
      code: "MODEL_TRANSPORT_UNAVAILABLE",
    });
    expect(sequence.sent).toHaveLength(2);
    closeMemoryDatabase(database);
  });
});
