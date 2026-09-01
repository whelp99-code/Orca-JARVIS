import { describe, expect, it } from "vitest";
import { ReconcileHub } from "../../src/dashboard/events.js";
import { MEMORY_TOPICS } from "../../src/dashboard/memory-contracts.js";

function payload(frame: string): Record<string, unknown> {
  const data = frame.split("\n").find(line => line.startsWith("data: "))?.slice(6);
  const value: unknown = JSON.parse(data ?? "null");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("SSE object required");
  }
  return Object.fromEntries(Object.entries(value));
}
function id(frame: string): string {
  return frame.split("\n").find(line => line.startsWith("id: "))?.slice(4) ?? "";
}

describe("Task 32 six-topic Memory SSE registry", () => {
  it("includes all six Memory topics in initial and replay-eviction snapshots", () => {
    // Given
    const hub = new ReconcileHub(); const initial: string[] = [];
    const disconnect = hub.connect({ write: frame => { initial.push(frame); }, close: () => {} });
    const firstId = id(initial[0] ?? ""); disconnect();
    for (let index = 0; index < 129; index += 1) hub.publish(["memory.records.v1"]);
    const resumed: string[] = [];
    // When
    const close = hub.connect({ write: frame => { resumed.push(frame); }, close: () => {} }, firstId);
    // Then
    expect(payload(initial[0] ?? "")["topics"]).toEqual(expect.arrayContaining([...MEMORY_TOPICS]));
    expect(payload(resumed[0] ?? "")["type"]).toBe("snapshot");
    expect(payload(resumed[0] ?? "")["topics"]).toEqual(expect.arrayContaining([...MEMORY_TOPICS]));
    close(); hub.close();
  });
});
