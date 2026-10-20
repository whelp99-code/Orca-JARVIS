import { describe, expect, it } from "vitest";
import { matchPhoneRoute } from "../../src/phone-gateway-routes.js";
import { PHONE_CORE_ROUTES, PHONE_GATEWAY_LIMITS } from "../../src/phone-gateway-protocol.js";

describe("phone product hub allowance", () => {
  it("allows exact product hub GET and the products shell, and denies writes and queries", () => {
    const hub = matchPhoneRoute({ method: "GET", path: "/api/v1/product-hub", rawUrl: "/api/v1/product-hub" });
    expect(hub).toEqual({
      kind: "ok", routeClass: "today", method: "GET", path: "/api/v1/product-hub", query: "",
      responseCap: PHONE_GATEWAY_LIMITS.jsonResponse, needsSession: true, needsCsrf: true, proxy: true,
    });
    const shell = matchPhoneRoute({ method: "GET", path: "/products", rawUrl: "/products" });
    expect(shell).toEqual({
      kind: "ok", routeClass: "shell", method: "GET", path: "/products", query: "",
      responseCap: PHONE_GATEWAY_LIMITS.html, needsSession: true, needsCsrf: false, proxy: false,
    });
    expect(matchPhoneRoute({ method: "POST", path: "/api/v1/product-hub", rawUrl: "/api/v1/product-hub" }).kind)
      .toBe("method_forbidden");
    expect(matchPhoneRoute({ method: "POST", path: "/products", rawUrl: "/products" }).kind).toBe("method_forbidden");
    expect(matchPhoneRoute({ method: "GET", path: "/api/v1/product-hub", rawUrl: "/api/v1/product-hub?limit=1" }).kind)
      .not.toBe("ok");
    expect(matchPhoneRoute({ method: "GET", path: "/products", rawUrl: "/products?next=/approvals" }).kind).not.toBe("ok");
    expect(PHONE_CORE_ROUTES).toContainEqual({
      method: "GET", path: "/api/v1/product-hub", routeClass: "today", proxyBranch: "today",
    });
    expect(PHONE_CORE_ROUTES).toContainEqual({
      method: "GET", path: "/products", routeClass: "shell", proxyBranch: undefined,
    });
  });
});
