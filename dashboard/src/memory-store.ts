import type { MemoryClient } from "./memory-api.js";
import type { MemorySnapshot } from "./memory-types.js";
export type MemoryStore = ReturnType<typeof createMemoryStore>;
export function createMemoryStore(client: MemoryClient) {
  let snapshot: MemorySnapshot = { state: "loading" };
  let epoch = 0; let active: AbortController | undefined; let activeLoad: AbortController | undefined;
  const listeners = new Set<() => void>();
  const assign = (value: MemorySnapshot): void => { snapshot = value; for (const listener of listeners) listener(); };
  async function load(): Promise<void> {
    activeLoad?.abort(); const controller = new AbortController(); activeLoad = controller;
    const generation = ++epoch;
    try {
      const [status, conflicts, candidates, effects] = await Promise.all([
        client.status(), client.conflicts(controller.signal), client.candidates(), client.effects()]);
      if (generation !== epoch || controller.signal.aborted) return;
      assign({ state: "ready", status, conflicts, candidates, effects });
    } catch (error) {
      if (generation !== epoch || controller.signal.aborted) return;
      assign({ state: "error", message: error instanceof Error ? error.message : "Memory unavailable" });
    } finally { if (activeLoad === controller) activeLoad = undefined; }
  }
  async function search(query: string): Promise<void> {
    active?.abort(); const controller = new AbortController(); active = controller; const generation = ++epoch;
    try {
      const search = await client.search(query, controller.signal);
      if (generation !== epoch || controller.signal.aborted) return;
      assign({ ...snapshot, state: "ready", search });
    } catch (error) {
      if (controller.signal.aborted || generation !== epoch) return;
      assign({ ...snapshot, state: "error", message: error instanceof Error ? error.message : "Search unavailable" });
    }
  }
  function clearPrivate(): void { epoch += 1; active?.abort(); active = undefined;
    activeLoad?.abort(); activeLoad = undefined;
    snapshot = snapshot.status === undefined ? { state: "loading" } : { state: "ready", status: snapshot.status };
    for (const listener of listeners) listener(); }
  return { getSnapshot: () => snapshot, subscribe(listener: () => void) { listeners.add(listener);
    return () => { listeners.delete(listener); }; }, load, search, clearPrivate };
}
