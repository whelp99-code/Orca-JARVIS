import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductHubResponse } from "../../src/dashboard/product-hub-contract.js";
import { createDashboardClient, DashboardApiError } from "./api.js";
import { ProductHub } from "./product-hub.js";
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

beforeEach(() => {
  for (const key of ["VITE_JARVIS_CRM_URL", "VITE_JARVIS_CRM_REVIEW_URL", "VITE_JARVIS_MAIL_URL",
    "VITE_JARVIS_MEMORY_URL", "VITE_JARVIS_MESSENGER_URL", "VITE_JARVIS_APPROVALS_URL"]) {
    vi.stubEnv(key, undefined);
  }
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

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
    expect(view.container.querySelector('#product-price a, #product-price button')).toBeNull();
    expect(view.container.querySelector("#product-price")).toHaveTextContent("화면 준비 중");
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

  it("uses the measured CRM web, CRM review and HTTPS Mail destinations without a Price link", () => {
    const view = render(<ProductHub />);
    expect(screen.getByRole("link", { name: "CRM 화면 열기" }))
      .toHaveAttribute("href", "https://jm-omachy.alpines-goldeye.ts.net:8448/");
    expect(screen.getByRole("link", { name: "CRM 후보 승인 화면 열기" }))
      .toHaveAttribute("href", "https://jm-omachy.alpines-goldeye.ts.net:8450/");
    expect(screen.getByRole("link", { name: "메일함 열기" }))
      .toHaveAttribute("href", "https://jm-omachy.alpines-goldeye.ts.net:8451/");
    expect(screen.getByRole("link", { name: "기억 화면 열기" })).toHaveAttribute("href", "/memory");
    expect(screen.getByRole("link", { name: "메신저 요약 보기" })).toHaveAttribute("href", "/products#product-messenger");
    expect(screen.getByRole("link", { name: "승인함 열기" })).toHaveAttribute("href", "/approvals");
    expect(view.container.querySelector('#product-price a, #product-price button')).toBeNull();
  });

  it("uses configured env destinations rather than hard-coded product ports", () => {
    const destinations = [
      ["VITE_JARVIS_CRM_URL", "CRM 화면 열기", "https://configured.example.ts.net/crm"],
      ["VITE_JARVIS_CRM_REVIEW_URL", "CRM 후보 승인 화면 열기", "https://configured.example.ts.net/crm-review"],
      ["VITE_JARVIS_MAIL_URL", "메일함 열기", "https://configured.example.ts.net/mail"],
      ["VITE_JARVIS_MEMORY_URL", "기억 화면 열기", "/configured-memory"],
      ["VITE_JARVIS_MESSENGER_URL", "메신저 요약 보기", "/configured-messenger"],
      ["VITE_JARVIS_APPROVALS_URL", "승인함 열기", "/configured-approvals"],
    ] as const;
    for (const [key, , href] of destinations) vi.stubEnv(key, href);
    const view = render(<ProductHub />);
    for (const [, label, href] of destinations) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
    }
    expect(view.container.querySelector('#product-price a, #product-price button')).toBeNull();
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
