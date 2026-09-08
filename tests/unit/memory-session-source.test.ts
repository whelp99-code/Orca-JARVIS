import { expect, it } from "vitest";
import { createPhoneGatewaySessionStore, PHONE_IDLE_MS, PHONE_COOKIE_NAME } from "../../src/dashboard/phone-session.js";
import { createPhoneMemorySessionSource } from "../../src/dashboard/memory-session-source.js";
it('uses live cookie/owner checks and does not extend idle expiry', () => {
  let now = Date.parse('2026-09-09T00:00:00.000Z');
  const owner = Buffer.alloc(32, 1); let currentOwner = owner;
  const sessions = createPhoneGatewaySessionStore({ key: Buffer.alloc(32, 2), now: () => now });
  const issued = sessions.issue(owner); if (issued.kind !== 'issued') throw new Error('fixture');
  let cookie: string | undefined = `${PHONE_COOKIE_NAME}=${issued.cookieId}`;
  const source = createPhoneMemorySessionSource({ sessions, cookieHeader: () => cookie,
    currentOwnerDigest: () => currentOwner, agentId: 'agent:phone', now: () => now });
  const first = source()!;
  expect(first).toMatchObject({ principal_id: 'principal:owner', agent_id: 'agent:phone' });
  expect(first.session_id).toMatch(/^session:phone:[a-f0-9]{64}$/);
  expect(JSON.stringify(first)).not.toContain(issued.cookieId);
  now += PHONE_IDLE_MS - 1;
  expect(source()).toEqual(first);
  now++;
  expect(source()).toBeUndefined();
  now -= PHONE_IDLE_MS;
  currentOwner = Buffer.alloc(32, 3); expect(source()).toBeUndefined();
  currentOwner = owner; cookie = undefined; expect(source()).toBeUndefined();
});
it('authentication results cannot mutate the stored session identity', () => {
  const sessions = createPhoneGatewaySessionStore({ key: Buffer.alloc(32, 2), now: () => 1 });
  const owner = Buffer.alloc(32, 1);
  const issued = sessions.issue(owner); if (issued.kind !== 'issued') throw new Error('fixture');
  const cookie = `${PHONE_COOKIE_NAME}=${issued.cookieId}`;
  const first = sessions.authenticate(cookie, owner); if (first.kind !== 'ok') throw new Error('fixture');
  const expected = first.idHmac.toString('hex'); first.idHmac.fill(0); first.csrfHmac.fill(0);
  const next = sessions.authenticate(cookie, owner); if (next.kind !== 'ok') throw new Error('fixture');
  expect(next.idHmac.toString('hex')).toBe(expected);
  expect(sessions.csrfMatches(next.csrfHmac, issued.csrfToken)).toBe(true);
});
