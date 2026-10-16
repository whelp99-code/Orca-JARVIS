import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardClient, type DashboardClient } from "./api.js";
import type { MemoryClient } from "./memory-api.js";
import { MemoryPage } from "./memory-page.js";
import { createMemoryStore } from "./memory-store.js";
import type { MemorySearch, MemoryStatus } from "./memory-types.js";
import { createPersonalClient } from "./personal-api.js";
import { ControlCenterRoot } from "./root.js";
import { createDashboardStore } from "./store.js";
import { SurfaceContext } from "./surface.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const T0 = Date.parse("2026-09-28T00:00:00Z");
const csrf = "csrf-fixture-token";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** Records every fetch the client makes; answers the gateway session and any read with a closed body. */
function stubFetch(answer: (url: string) => unknown) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    return jsonResponse(answer(url));
  });
  return calls;
}

const status: MemoryStatus = { schema_version: 1, resource: "memory-status", state: "ready", privacy_epoch: 0,
  checked_at: new Date(T0).toISOString(), fresh_until: new Date(T0 + 60_000).toISOString(),
  contract_schema: 4, mutations_enabled: true };
const search: MemorySearch = { schema_version: 1, resource: "memory-search", state: "ready",
  generated_at: new Date(T0).toISOString(), checked_at: new Date(T0).toISOString(),
  fresh_until: new Date(T0 + 60_000).toISOString(), privacy_epoch: 0, query_revision: "q", resource_revision: "r",
  provider_generation: null, truncated: false, omissions: [], items: [{ record_token: "token-one",
    record_revision: "revision-one", title: "Fixture title", excerpt: "Fixture body", citation: "Memory citation",
    sensitivity: "personal", retention: { source: "policy", days: 30, expires_at: new Date(T0 + 100_000).toISOString() },
    freshness: "fresh", provenance: { source_class: "memory", owner_class: "provider_owned", origin_label: "Fixture",
      origin_revision: "origin-one" }, conflict_state: "none", history_state: "current", superseded_by: null,
    history: [], actions: ["inspect", "correct", "forget", "export"] }] };
const conflicts = { schema_version: 1, resource: "memory-conflicts", generated_at: new Date(T0).toISOString(),
  state: "ready", privacy_epoch: 0, items: [], truncated: false };

function memoryClient() {
  const calls = { status: 0, conflicts: 0, candidates: 0, effects: 0, rememberProgress: 0 };
  const client = {
    status: async () => { calls.status += 1; return status; },
    conflicts: async () => { calls.conflicts += 1; return conflicts; },
    search: async () => search,
    candidates: async () => { calls.candidates += 1; throw new Error("MEMORY_REQUEST_FAILED"); },
    effects: async () => { calls.effects += 1; throw new Error("MEMORY_REQUEST_FAILED"); },
    rememberProgress: async () => { calls.rememberProgress += 1; throw new Error("MEMORY_REQUEST_FAILED"); },
    correct: vi.fn(), forget: vi.fn(), exportRecord: vi.fn(), candidate: vi.fn(),
    candidateDecision: vi.fn(), candidateDispatch: vi.fn(),
  } as unknown as MemoryClient;
  return { client, calls };
}

async function settled(): Promise<void> {
  for (let tick = 0; tick < 32; tick += 1) await Promise.resolve();
}

describe("phone surface", () => {
  it("bootstraps CSRF from the gateway session route once per page", async () => {
    // Given the gateway session route
    const calls = stubFetch(() => ({ schema_version: 1, csrf_token: csrf, expires_at: new Date(T0).toISOString() }));
    const client = createDashboardClient("phone");
    // When two consumers ask for the session
    const [first, second] = await Promise.all([client.session(), client.session()]);
    // Then one gateway session is minted and shared
    expect(first.csrf_token).toBe(csrf);
    expect(second).toBe(first);
    expect(calls.map(call => call.url)).toEqual(["/api/v1/phone/session"]);
  });

  it("sends the phone CSRF token on every Today read", async () => {
    // Given a phone session and a closed Today body
    const calls = stubFetch(() => ({}));
    const client = createPersonalClient(async () => ({ schema_version: 1, csrf_token: csrf }), "phone");
    // When Today is read
    await client.today().catch(() => undefined);
    // Then the read carries the gateway CSRF header
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/v1/today");
    expect(calls[0]?.headers.get("x-jarvis-csrf")).toBe(csrf);
  });

  it("reads only the gateway's Memory read routes and opens no live stream", async () => {
    // Given a phone memory store whose write and candidate routes would 404
    const { client, calls } = memoryClient();
    const store = createMemoryStore({ client, clock: () => T0, surface: "phone" });
    // When it starts
    store.start();
    await settled();
    // Then it is ready from status and conflicts alone
    const snapshot = store.getSnapshot();
    expect(snapshot.state).toBe("ready");
    expect(snapshot.conflicts).toBe(conflicts);
    expect(calls).toEqual({ status: 1, conflicts: 1, candidates: 0, effects: 0, rememberProgress: 0 });
    store.stop();
  });

  it("navigates only the read-only routes and never starts the authority stream", () => {
    // Given the root rendered for the phone surface
    const session = vi.fn(async () => ({ schema_version: 1 as const, csrf_token: csrf }));
    const client = { session } as unknown as DashboardClient;
    const sources: string[] = [];
    const store = createDashboardStore({ client, eventSourceFactory: url => {
      sources.push(url);
      return { onopen: null, onerror: null, addEventListener: () => undefined, close: () => undefined };
    } });
    // When it mounts
    render(<ControlCenterRoot store={store} client={client} initialPath="/" surface="phone" />);
    // Then the product directory joins the existing phone routes without an authority stream.
    const nav = screen.getByRole("navigation", { name: "주요 메뉴" });
    expect(within(nav).getAllByRole("link").map(link => link.getAttribute("href"))).toEqual(["/", "/products", "/memory", "/approvals", "/security"]);
    expect(session).not.toHaveBeenCalled();
    expect(sources).toEqual([]);
    expect(screen.getByRole("status", { name: "실시간" })).toHaveAttribute("data-state", "readonly");
  });

  it("exposes no memory mutation controls even when the provider allows them", async () => {
    // Given a ready provider with mutations enabled and a selectable record
    const { client } = memoryClient();
    const store = createMemoryStore({ client, clock: () => T0, surface: "phone" });
    render(<SurfaceContext.Provider value="phone"><MemoryPage store={store} client={client} /></SurfaceContext.Provider>);
    await act(async () => { await settled(); });
    fireEvent.change(screen.getByLabelText("기억 검색"), { target: { value: "fixture" } });
    fireEvent.click(screen.getByRole("button", { name: "기억 검색" }));
    await act(async () => { await settled(); });
    // When the record is selected
    fireEvent.click(screen.getByRole("button", { name: /Fixture title/ }));
    // Then no staging control, candidate panel or effects panel exists
    expect(screen.getByRole("heading", { level: 3, name: "Fixture title" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Stage/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Prepare/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "바꿀 내용" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Candidates" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "효과와 개인정보 영수증" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "내용" })).queryByRole("button")).not.toBeInTheDocument();
  });
});
