import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserSecurityClient } from "./security-page.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser security client ceremonies", () => {
  it("calls navigator.credentials.get with the server challenge and submits the assertion", async () => {
    const get = vi.fn(async () => {
      throw new Error("ceremony-stop");
    });
    vi.stubGlobal("navigator", { credentials: { get, create: vi.fn() } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url) === "/api/v1/session") {
        return { ok: true, json: async () => ({ schema_version: 1, csrf_token: "local-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) };
      }
      if (String(url).endsWith("/options")) {
        return {
          ok: true,
          json: async () => ({
            challenge_id: "rch_1",
            options: { challenge: "AAAA", rpId: "localhost", timeout: 30000, userVerification: "required", allowCredentials: [] },
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    }));
    const client = createBrowserSecurityClient();
    await expect(client.decideRemote("request-1", "approve")).rejects.toThrow("ceremony-stop");
    expect(get).toHaveBeenCalledTimes(1);
  });
});
