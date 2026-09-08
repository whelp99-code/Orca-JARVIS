import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPhoneGatewaySessionStore } from "../../src/dashboard/phone-session.js";

const KEY = Buffer.alloc(32, 9);
const OWNER = createHash("sha256").update("owner@example.invalid").digest();
const OTHER = createHash("sha256").update("other@example.invalid").digest();

describe("phone gateway session store", () => {
  it("issues a Host-prefix Secure cookie and stores only HMACs", () => {
    // Given
    const now = 1_700_000_000_000;
    const store = createPhoneGatewaySessionStore({ key: KEY, now: () => now });
    // When
    const issued = store.issue(OWNER);
    // Then
    if (issued.kind !== "issued") throw new Error("session required");
    expect(issued.setCookie).toMatch(
      /^__Host-jarvis-phone=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=900$/,
    );
    expect(issued.setCookie).not.toMatch(/Domain=/i);
    expect(issued.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const dumped = JSON.stringify(store.inspectDigests());
    expect(dumped).not.toContain(issued.cookieId);
    expect(dumped).not.toContain(issued.csrfToken);
    const idHmac = createHmac("sha256", KEY).update(issued.cookieId).digest("hex");
    expect(store.inspectDigests()).toEqual(expect.arrayContaining([idHmac]));
  });

  it("binds the session to the owner digest and rejects a different owner", () => {
    const store = createPhoneGatewaySessionStore({ key: KEY, now: () => 1 });
    const issued = store.issue(OWNER);
    if (issued.kind !== "issued") throw new Error("session required");
    const ok = store.authenticate(`__Host-jarvis-phone=${issued.cookieId}`, OWNER);
    const wrong = store.authenticate(`__Host-jarvis-phone=${issued.cookieId}`, OTHER);
    expect(ok.kind).toBe("ok");
    expect(wrong.kind).toBe("invalid");
  });

  it("expires idle after 15 minutes and absolute after 8 hours with an injected clock", () => {
    let now = 0;
    const store = createPhoneGatewaySessionStore({ key: KEY, now: () => now });
    const issued = store.issue(OWNER);
    if (issued.kind !== "issued") throw new Error("session required");
    const cookie = `__Host-jarvis-phone=${issued.cookieId}`;
    now = 15 * 60 * 1000;
    expect(store.authenticate(cookie, OWNER).kind).toBe("ok");
    now = 15 * 60 * 1000 + 1;
    expect(store.authenticate(cookie, OWNER).kind).toBe("invalid");
    now = 0;
    const held = store.issue(OWNER);
    if (held.kind !== "issued") throw new Error("session required");
    const heldCookie = `__Host-jarvis-phone=${held.cookieId}`;
    const step = 14 * 60 * 1000;
    for (let tick = step; tick < 8 * 60 * 60 * 1000; tick += step) {
      now = tick;
      const mid = store.authenticate(heldCookie, OWNER);
      expect(mid.kind).toBe("ok");
      if (mid.kind === "ok") store.touch(mid.idHmac);
    }
    now = 8 * 60 * 60 * 1000 - 1;
    expect(store.authenticate(heldCookie, OWNER).kind).toBe("ok");
    now = 8 * 60 * 60 * 1000 + 1;
    expect(store.authenticate(heldCookie, OWNER).kind).toBe("invalid");
  });

  it("compares CSRF with HMAC plus timing-safe equality", () => {
    const store = createPhoneGatewaySessionStore({ key: KEY, now: () => 0 });
    const issued = store.issue(OWNER);
    if (issued.kind !== "issued") throw new Error("session required");
    const auth = store.authenticate(`__Host-jarvis-phone=${issued.cookieId}`, OWNER);
    if (auth.kind !== "ok") throw new Error("auth required");
    expect(store.csrfMatches(auth.csrfHmac, issued.csrfToken)).toBe(true);
    expect(store.csrfMatches(auth.csrfHmac, `${issued.csrfToken}x`)).toBe(false);
    expect(store.csrfMatches(auth.csrfHmac, issued.csrfToken.slice(0, 32))).toBe(false);
  });

  it("rejects duplicate cookie names, multiple cookie headers, and capacity overflow without evicting live sessions", () => {
    const store = createPhoneGatewaySessionStore({ key: KEY, now: () => 0 });
    const issued = store.issue(OWNER);
    if (issued.kind !== "issued") throw new Error("session required");
    expect(store.authenticate(
      `__Host-jarvis-phone=${issued.cookieId}; __Host-jarvis-phone=${issued.cookieId}`,
      OWNER,
    ).kind).toBe("invalid");
    const live = new Set<string>([issued.cookieId]);
    for (let index = 1; index < 128; index += 1) {
      const next = store.issue(OWNER);
      if (next.kind !== "issued") throw new Error("capacity too early");
      live.add(next.cookieId);
    }
    expect(store.issue(OWNER).kind).toBe("capacity");
    expect(store.authenticate(`__Host-jarvis-phone=${issued.cookieId}`, OWNER).kind).toBe("ok");
  });

  it("invalidates every session when a new store is constructed", () => {
    const first = createPhoneGatewaySessionStore({ key: KEY, now: () => 0 });
    const issued = first.issue(OWNER);
    if (issued.kind !== "issued") throw new Error("session required");
    const second = createPhoneGatewaySessionStore({ key: KEY, now: () => 0 });
    expect(second.authenticate(`__Host-jarvis-phone=${issued.cookieId}`, OWNER).kind).toBe("invalid");
  });
});

it.each([999, Number.NaN, Number.NEGATIVE_INFINITY])('rejects invalid or pre-issuance authentication clocks: %s', changed => {
  let now = 1000;
  const store = createPhoneGatewaySessionStore({ key: KEY, now: () => now });
  const issued = store.issue(OWNER);
  if (issued.kind !== 'issued') throw new Error('fixture');
  const cookie = `__Host-jarvis-phone=${issued.cookieId}`;
  const auth = store.authenticate(cookie, OWNER);
  if (auth.kind !== 'ok') throw new Error('fixture');
  now = changed;
  expect(store.touch(auth.idHmac)).toBeUndefined();
  expect(store.authenticate(cookie, OWNER).kind).toBe('invalid');
});
it('rejects a clock earlier than the last successful session touch', () => {
  let now = 1000;
  const store = createPhoneGatewaySessionStore({ key: KEY, now: () => now });
  const issued = store.issue(OWNER); if (issued.kind !== 'issued') throw new Error('fixture');
  const cookie = `__Host-jarvis-phone=${issued.cookieId}`;
  const auth = store.authenticate(cookie, OWNER); if (auth.kind !== 'ok') throw new Error('fixture');
  now = 2000; expect(store.touch(auth.idHmac)).toBeDefined();
  now = 1999; expect(store.authenticate(cookie, OWNER).kind).toBe('invalid');
  now = 2000; expect(store.authenticate(cookie, OWNER).kind).toBe('invalid');
});
it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('does not issue a session with an invalid clock: %s', now => {
  const store = createPhoneGatewaySessionStore({ key: KEY, now: () => now });
  expect(() => store.issue(OWNER)).toThrow('PHONE_SESSION_CLOCK_INVALID');
  expect(store.inspectDigests()).toEqual([]);
});
