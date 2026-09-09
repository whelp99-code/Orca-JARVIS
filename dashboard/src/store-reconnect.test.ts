import { afterEach, expect, it, vi } from "vitest";
import { createDashboardStore } from "./store.js";
import { createHarness, FakeEventSource, frame, SNAPSHOT_TOPICS } from "./store-test-harness.js";

afterEach(() => vi.useRealTimers());

it("reopens a terminal SSE failure once and ignores events from the replaced connection", async () => {
  vi.useFakeTimers();
  const { client } = createHarness();
  const sources: Array<FakeEventSource & { readyState: number }> = [];
  const store = createDashboardStore({ client, eventSourceFactory: url => {
    const source = Object.assign(new FakeEventSource(url), { readyState: 0 });
    sources.push(source); return source;
  } });
  try {
    store.start(); await vi.advanceTimersByTimeAsync(0);
    const first = sources[0]!;
    first.readyState = 2; first.fail(); first.fail();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(2); expect(first.closed).toBe(true);
    const second = sources[1]!;
    second.readyState = 1; second.open();
    expect(store.getSnapshot().connectionState).toBe("live");
    const before = { ...client.calls };
    first.fail(); first.emit("snapshot", frame("snapshot", SNAPSHOT_TOPICS, "old:1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().connectionState).toBe("live");
    expect(client.calls).toEqual(before);
    second.emit("snapshot", frame("snapshot", SNAPSHOT_TOPICS, "new:1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.calls.overview).toBe(before.overview + 1);
    second.readyState = 2; second.fail(); store.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sources).toHaveLength(2);
  } finally { store.stop(); }
});

it("leaves native reconnecting EventSource ownership with the browser", async () => {
  vi.useFakeTimers();
  const { client } = createHarness();
  const source = Object.assign(new FakeEventSource("/events"), { readyState: 0 });
  const factory = vi.fn(() => source);
  const store = createDashboardStore({ client, eventSourceFactory: factory });
  try {
    store.start(); await vi.advanceTimersByTimeAsync(0);
    source.fail(); await vi.advanceTimersByTimeAsync(10_000);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(false);
    expect(store.getSnapshot().connectionState).toBe("reconnecting");
  } finally { store.stop(); }
});
