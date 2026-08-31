import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSecondBrainWriteRequestAdapter } from "../../src/second-brain-adapter.js";
import type { SecondBrainCallOptions, SecondBrainMethod, SecondBrainOutcome, SecondBrainTransport } from "../../src/second-brain-transport.js";

class CapturingTransport implements SecondBrainTransport {
  readonly calls: Array<{ readonly method: SecondBrainMethod; readonly arguments_: Readonly<Record<string, unknown>> }> = [];
  constructor(private readonly outcome: SecondBrainOutcome) {}
  call(method: SecondBrainMethod, arguments_: Readonly<Record<string, unknown>>, options?: SecondBrainCallOptions): Promise<SecondBrainOutcome> {
    void options;
    this.calls.push({ method, arguments_ });
    return Promise.resolve(this.outcome);
  }
  restart(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
  diagnostics(): readonly [] { return []; }
}

function fixtureRequest(): unknown {
  const parsed: unknown = JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("fixture invalid");
  const tools = Reflect.get(parsed, "tools");
  const write = typeof tools === "object" && tools !== null ? Reflect.get(tools, "sb_write_request") : undefined;
  const happy = typeof write === "object" && write !== null ? Reflect.get(write, "happy") : undefined;
  const args = typeof happy === "object" && happy !== null ? Reflect.get(happy, "arguments") : undefined;
  return typeof args === "object" && args !== null ? Reflect.get(args, "request") : undefined;
}

describe("Second Brain write-request adapter", () => {
  it("parses the closed request and calls only sb_write_request", async () => {
    // Given
    const transport = new CapturingTransport({ kind: "data", value: { schema_version: 1, kind: "accepted", state: "pending", candidate_id: `memcand:pos:v1:${"1".repeat(64)}`, request_id: `memreq:pos:v1:${"2".repeat(64)}`, request_digest: `sha256:${"2".repeat(64)}`, idempotency_key: `memidem:pos:v1:${"3".repeat(64)}`, operation: "remember", accepted_at: "2026-08-31T12:00:00.000Z", inbox_path: `inbox/.requests/pending/memreq:pos:v1:${"2".repeat(64)}.json`, request_file_digest: `sha256:${"4".repeat(64)}`, replayed: false } });
    const adapter = createSecondBrainWriteRequestAdapter(transport);
    // When
    const result = await adapter.write(fixtureRequest());
    // Then
    expect(result).toMatchObject({ kind: "accepted", state: "pending", operation: "remember", replayed: false });
    expect(transport.calls).toEqual([{ method: "sb_write_request", arguments_: { request: fixtureRequest() } }]);
  });

  it("rejects malformed input before transport", async () => {
    // Given
    const transport = new CapturingTransport({ kind: "data", value: {} });
    // When / Then
    await expect(createSecondBrainWriteRequestAdapter(transport).write({ operation: "remember" })).resolves.toEqual({ kind: "invalid", code: "SECOND_BRAIN_WRITE_REQUEST_INVALID" });
    expect(transport.calls).toEqual([]);
  });
});
