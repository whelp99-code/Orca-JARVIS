import type { MemoryClient } from "./memory-api.js";
import { MemoryPage } from "./memory-page.js";
import type { MemoryStore } from "./memory-store.js";
export type MemoryClientRuntime = { readonly client: MemoryClient; readonly store: MemoryStore };
export function MemoryRoute({ runtime }: Readonly<{ runtime?: MemoryClientRuntime }>) {
  if (runtime === undefined) return <div className="page-frame route-state"><section role="alert">
    <h1>Memory</h1><p>Memory client is unavailable.</p></section></div>;
  return <MemoryPage store={runtime.store} client={runtime.client} />;
}
