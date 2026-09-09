import { expect, it } from "vitest";
import { validateMemoryBody } from "../../src/phone-gateway-body.js";
import { matchPhoneRoute } from "../../src/phone-gateway-routes.js";
const path = '/api/v1/memory/reconcile';
it('accepts only one canonical scoped outbox target and rejects injected authority', () => {
  const body = { schema_version: 1, outbox_id: 'memout:scoped:v4:' + 'a'.repeat(64) };
  expect(validateMemoryBody(path, Buffer.from(JSON.stringify(body)))).toBe(true);
  for (const value of [{ ...body, session_id: 'session:forged' }, { ...body, outbox_id: '../db' }, { ...body, schema_version: 4 }])
    expect(validateMemoryBody(path, Buffer.from(JSON.stringify(value)))).toBe(false);
  expect(validateMemoryBody(path, Buffer.from('{"schema_version":1,"schema_version":1,"outbox_id":"' + body.outbox_id + '"}'))).toBe(false);
});
it('requires a session and CSRF and never proxies reconciliation', () => {
  const result = matchPhoneRoute({ method: 'POST', path, rawUrl: path });
  expect(result).toMatchObject({ kind: 'ok', routeClass: 'memory_reconcile', needsSession: true, needsCsrf: true, proxy: false });
});
