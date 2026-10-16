import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductHubResponse } from "../../src/dashboard/product-hub-contract.js";
import { createDashboardClient, DashboardApiError } from "./api.js";
import { ProductHub, productScreen } from "./product-hub.js";
import { ControlCenterRoot } from "./root.js";
import { createDashboardStore } from "./store.js";

const AT = "2026-10-16T03:00:00.000Z";
const value: ProductHubResponse = {
  schema_version: 1, generated_at: AT,
  items: [
    { id: "crm", state: "ready", observed_at: AT, count: 12, secondary_count: null, oldest_age_ms: null },
    { id: "mail", state: "ready", observed_at: AT, count: 29, secondary_count: 17, oldest_age_ms: null },
    { id: "price", state: "configured", observed_at: null, count: null, secondary_count: null, oldest_age_ms: null },
    { id: "second_brain", state: "ready", observed_at: AT, count: 4, secondary_count: null, oldest_age_ms: null },
    { id: "messenger", state: "no_data", observed_at: AT, count: 0, secondary_count: null, oldest_age_ms: null },
    { id: "approvals", state: "ready", observed_at: AT, count: 2, secondary_count: null, oldest_age_ms: null },
  ],
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function deferred<T>() {
  const callbacks: { resolve?: (value: T | PromiseLike<T>) => void; reject?: (reason: Error) => void } = {};
  const promise = new Promise<T>((resolve, reject) => {
    callbacks.resolve = resolve; callbacks.reject = reject;
  });
  const { resolve, reject } = callbacks;
  if (resolve === undefined || reject === undefined) throw new Error("deferred fixture invalid");
  return { promise, resolve, reject };
}

describe("read-only product Hub", () => {
  it("keeps six cards visible while loading and shows each source's own count", async () => {
    const pending = deferred<ProductHubResponse>();
    const view = render(<ProductHub load={() => pending.promise} />);
    expect(view.container.querySelectorAll("[data-product]")).toHaveLength(6);
    expect(view.container.querySelectorAll('[data-state="loading"]')).toHaveLength(6);
    await act(async () => { pending.resolve(value); await pending.promise; });
    expect(view.container.querySelector('[data-product-summary="crm"]')).toHaveTextContent("12건");
    expect(view.container.querySelector('[data-product-summary="mail"]')).toHaveTextContent("29건");
    expect(view.container.querySelector('[data-product-summary="mail"]')).toHaveTextContent("17건");
    expect(view.container.querySelector('[data-product-summary="messenger"]')).toHaveTextContent("0건");
    expect(view.container.querySelector('[data-product="price"]')).toHaveAttribute("data-state", "configured");
    expect(view.container.querySelector('[data-product-summary="price"]')).not.toHaveTextContent("0원");
    expect(screen.queryByRole("button", { name: /승인|전송|확정/ })).not.toBeInTheDocument();
  });

  it("retires old counts after a denied refresh without rendering raw errors", async () => {
    const next = deferred<ProductHubResponse>();
    let reads = 0;
    const load = () => ++reads === 1 ? Promise.resolve(value) : next.promise;
    const view = await act(async () => render(<ProductHub load={load} />));
    expect(view.container.querySelector('[data-product-summary="crm"]')).toHaveTextContent("12건");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "제품 요약 새로고침" }));
    });
    await act(async () => {
      next.reject(new DashboardApiError({
        kind: "forbidden", code: "LOCAL_SESSION_REQUIRED", message: "private-provider-body", request_id: "",
      }));
      await next.promise.catch(() => undefined);
    });
    expect(view.container.querySelectorAll('[data-state="denied"]')).toHaveLength(6);
    expect(view.container.querySelector('[data-product-summary="crm"]')).not.toHaveTextContent("12건");
    expect(view.container).not.toHaveTextContent("private-provider-body");
    expect(view.container.querySelector('[data-product-summary="crm"]')).not.toHaveTextContent("0건");
  });

  it("ignores a retired loader's late response", async () => {
    const old = deferred<ProductHubResponse>();
    const load = () => old.promise;
    const view = render(<ProductHub load={load} />);
    await act(async () => { view.rerender(<ProductHub load={async () => ({
      ...value, items: [{ ...value.items[0], count: 8 }, value.items[1], value.items[2],
        value.items[3], value.items[4], value.items[5]],
    })} />); });
    await act(async () => { old.resolve(value); await old.promise; });
    expect(view.container.querySelector('[data-product-summary="crm"]')).toHaveTextContent("8건");
    expect(view.container.querySelector('[data-product-summary="crm"]')).not.toHaveTextContent("12건");
  });

  it("keeps product destinations on the entry hostname and fixed existing routes", () => {
    const origin = "https://representative.example.ts.net:8444";
    expect(productScreen("crm", origin)).toBe("https://representative.example.ts.net:8446/");
    expect(productScreen("mail", origin)).toBe("http://representative.example.ts.net:3010/");
    expect(productScreen("price", origin)).toBe("https://representative.example.ts.net:8450/");
    expect(productScreen("second_brain", origin)).toBe("/memory");
    expect(productScreen("messenger", origin)).toBe("/products#product-messenger");
    expect(productScreen("approvals", origin)).toBe("/approvals");
  });

  it("mounts on the real phone root even when personal data cannot load, without authority reads", async () => {
    const calls: Array<{ path: string; method: string; csrf: string | null }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, method: init?.method ?? "GET", csrf: new Headers(init?.headers).get("x-jarvis-csrf") });
      return new Response(JSON.stringify(path === "/api/v1/phone/session"
        ? { schema_version: 1, csrf_token: "shared-phone-token" } : value), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    const client = createDashboardClient("phone");
    const source = vi.fn(() => { throw new Error("authority stream must not start"); });
    const store = createDashboardStore({ client, eventSourceFactory: source });
    const view = await act(async () => render(<ControlCenterRoot store={store} client={client}
      initialPath="/" surface="phone" />));
    expect(view.container.querySelectorAll("[data-product]")).toHaveLength(6);
    expect(view.container.querySelector('[data-product-summary="crm"]')).toHaveTextContent("12건");
    expect(calls).toEqual([
      { path: "/api/v1/phone/session", method: "GET", csrf: null },
      { path: "/api/v1/product-hub", method: "GET", csrf: "shared-phone-token" },
    ]);
    expect(source).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "메신저 요약 보기" })).toHaveAttribute("href", "/products#product-messenger");
  });

  it("rejects malformed counts at the existing GET client boundary", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => new Response(JSON.stringify(
      String(input) === "/api/v1/session" ? { schema_version: 1, csrf_token: "local-token" }
        : { ...value, items: value.items.map(item => item.id === "crm" ? { ...item, count: -1 } : item) },
    ), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createDashboardClient();
    if (client.productHub === undefined) throw new Error("productHub client missing");
    await expect(client.productHub()).rejects.toThrow();
  });
});
