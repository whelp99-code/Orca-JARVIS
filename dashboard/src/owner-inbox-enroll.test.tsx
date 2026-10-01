import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerInboxPanel } from "./owner-inbox-panel.js";
import { enrollErrorMessage } from "./owner-inbox-enroll.js";

const options = {
  schema_version: 1,
  phase: "options",
  challenge: "AAAA",
  rp: { id: "localhost", name: "JARVIS" },
  user: { id: "amFydmlzLW93bmVy", name: "owner", displayName: "소유자" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  timeout: 60_000,
  attestation: "none",
  authenticatorSelection: { residentKey: "required", userVerification: "required" },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function inbox(enrolled = false): Response {
  return json(200, { schema_version: 1, items: [], passkey_enrolled: enrolled });
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("owner inbox enrollment", () => {
  it("registers a passkey with the one-time code and the server challenge", async () => {
    class PublicKeyCredential {}
    class AuthenticatorAttestationResponse {}
    vi.stubGlobal("PublicKeyCredential", PublicKeyCredential);
    vi.stubGlobal("AuthenticatorAttestationResponse", AuthenticatorAttestationResponse);
    const created = Object.assign(new PublicKeyCredential(), {
      id: "cred-id",
      response: Object.assign(new AuthenticatorAttestationResponse(), {
        clientDataJSON: new Uint8Array([1, 2]).buffer,
        attestationObject: new Uint8Array([3]).buffer,
      }),
    });
    const create = vi.fn(async () => created);
    vi.stubGlobal("navigator", { credentials: { create, get: vi.fn() } });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/session") return json(200, { csrf_token: "csrf-1" });
      if (url === "/api/v1/owner-inbox") return inbox(false);
      const body = JSON.parse(String(init?.body)) as { phase?: string; attestation?: { id: string } };
      if (body.phase === "options") return json(200, options);
      expect(body.attestation?.id).toBe("cred-id");
      expect(init?.headers).toMatchObject({ "X-JARVIS-CSRF": "csrf-1" });
      return json(200, { schema_version: 1, credential_id: "cred-id" });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<OwnerInboxPanel />);
    const input = await screen.findByLabelText("일회용 등록 코드");
    await userEvent.type(input, "one-time-code");
    await userEvent.click(screen.getByRole("button", { name: "등록하기" }));
    expect((await screen.findByRole("status")).textContent ?? "").not.toHaveLength(0);
    expect(create).toHaveBeenCalledOnce();
    const publicKey = (create.mock.calls as unknown as [{ publicKey: { challenge: ArrayBuffer } }[]])[0]?.[0]?.publicKey;
    expect(publicKey).toBeDefined();
    expect(new Uint8Array(publicKey!.challenge)).toEqual(Uint8Array.from(atob("AAAA"), (char) => char.charCodeAt(0)));
  });

  it("maps a wrong code and an expired code to Korean", async () => {
    vi.stubGlobal("navigator", { credentials: { create: vi.fn(), get: vi.fn() } });
    let fail = "OWNER_INBOX_IDENTITY_REQUIRED";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/v1/session") return json(200, { csrf_token: "csrf-1" });
      if (url === "/api/v1/owner-inbox") return inbox(false);
      return json(401, { error: { code: fail } });
    }));
    render(<OwnerInboxPanel />);
    await userEvent.type(await screen.findByLabelText("일회용 등록 코드"), "bad");
    await userEvent.click(screen.getByRole("button", { name: "등록하기" }));
    const wrong = await screen.findByRole("alert");
    expect(wrong.textContent ?? "").not.toHaveLength(0);
    fail = "OWNER_INBOX_EXPIRED";
    await userEvent.click(screen.getByRole("button", { name: "등록하기" }));
    const expired = await screen.findByRole("alert");
    expect(expired.textContent ?? "").not.toHaveLength(0);
    expect(expired.textContent).not.toBe(wrong.textContent);
    expect(enrollErrorMessage("OWNER_INBOX_REPLAY")).not.toBe(enrollErrorMessage("OWNER_INBOX_EXPIRED"));
    expect(enrollErrorMessage("OWNER_INBOX_ORIGIN_MISMATCH")).not.toBe(enrollErrorMessage("OWNER_INBOX_IDENTITY_REQUIRED"));
  });
});
