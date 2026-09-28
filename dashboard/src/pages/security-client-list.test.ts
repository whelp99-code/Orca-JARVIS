import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserSecurityClient } from "./security-page.js";

type Call = { readonly url: string; readonly csrf: string | null };

function stubFetch(input: { readonly sessionPath: string; readonly token: string }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), csrf: headers.get("x-jarvis-csrf") });
    if (String(url) === input.sessionPath) {
      return { ok: true, status: 200, json: async () => ({ schema_version: 1, csrf_token: input.token }) };
    }
    if (String(url) === "/api/v1/security/webauthn/credentials" && headers.get("x-jarvis-csrf") === input.token) {
      return { ok: true, status: 200, json: async () => ({ schema_version: 1, items: [{ credential_id_prefix: "abcd", state: "active" }] }) };
    }
    return { ok: false, status: 403, json: async () => ({ schema_version: 1, error: { code: "FORBIDDEN", message: "Forbidden" } }) };
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.innerHTML = "";
});

describe("browser security client credential list", () => {
  it("lists with the phone CSRF token on the gateway origin and never asks for the local session", async () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "jarvis-phone-mode");
    meta.setAttribute("content", "1");
    document.head.append(meta);
    const calls = stubFetch({ sessionPath: "/api/v1/phone/session", token: "phone-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa" });

    const listed = await createBrowserSecurityClient().listCredentials();

    expect(listed.items).toEqual([{ credential_id_prefix: "abcd", state: "active" }]);
    expect(calls.map(call => call.url)).not.toContain("/api/v1/session");
    expect(calls.find(call => call.url === "/api/v1/security/webauthn/credentials")?.csrf).toBe("phone-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("lists with the local session CSRF token on the local origin", async () => {
    const calls = stubFetch({ sessionPath: "/api/v1/session", token: "local-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa" });

    const listed = await createBrowserSecurityClient().listCredentials();

    expect(listed.items).toEqual([{ credential_id_prefix: "abcd", state: "active" }]);
    expect(calls.map(call => call.url)).not.toContain("/api/v1/phone/session");
    expect(calls.find(call => call.url === "/api/v1/security/webauthn/credentials")?.csrf).toBe("local-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});
