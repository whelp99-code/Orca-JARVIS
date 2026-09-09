import { createHash, createHmac } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "undici";
import { expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { createPhoneGatewayServer, parsePhoneGatewayConfig } from "../../src/phone-gateway.js";
import { registerMemoryScopedOutbox } from "../../src/memory-scoped-outbox.js";
import { claimMemoryScopedOutbox, markMemoryScopedOutboxDispatch } from "../../src/memory-scoped-outbox-worker.js";
import { scopedOutboxFixture } from "../fixtures/scoped-outbox.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { FIXTURE_HOST, FIXTURE_LOGIN, FIXTURE_ORIGIN, cookieFromSetCookie, makePhoneHome,
  processUid, startFakeAuthority } from "../fixtures/phone-gateway-harness.js";

it("verifies the original dispatch through live gateway login, CSRF and current policy", async () => {
  const f = await scopedOutboxFixture();
  const home = makePhoneHome();
  const config = parsePhoneGatewayConfig({ home: home.home, envFile: home.envFile, uid: processUid() });
  const upstream = await startFakeAuthority();
  const staticRoot = join(f.database.root, "http-static");
  mkdirSync(join(staticRoot, "assets"), { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), '<div id="root"></div>');
  writeFileSync(join(staticRoot, "manifest.json"), JSON.stringify({ "index.html": { file: "assets/app.js" } }));
  writeFileSync(join(staticRoot, "assets/app.js"), "1");
  const policyPath = join(f.database.root, "write-policy.json");
  let at = f.now.getTime();
  const audits: string[] = [];
  const gateway = createPhoneGatewayServer({ host: "127.0.0.1", port: 0, upstream: upstream.origin,
    staticRoot, config, now: () => at, audit: line => { audits.push(line); },
    memoryProviderVerifier: { authority: f.database.authority, agent_id: "agent:fixture",
      provider_instance_id: "provider:fixture", policy_path: policyPath, spool_root: f.options.spoolRoot,
      roots: f.dispatch.roots } });
  try {
    const origin = `http://127.0.0.1:${gateway.address.port}`;
    const login = await request(`${origin}/api/v1/phone/session`, {
      headers: { Host: FIXTURE_HOST, "Tailscale-User-Login": FIXTURE_LOGIN } });
    expect(login.statusCode).toBe(200);
    const cookie = cookieFromSetCookie(login.headers["set-cookie"])!;
    const csrf = (await login.body.json() as { csrf_token: string }).csrf_token;
    const sessionHmac = createHmac("sha256", config.sessionKey).update(cookie).digest();
    const sessionId = `session:phone:${createHash("sha256").update("orca-jarvis/phone-memory-session/v1\0").update(sessionHmac).digest("hex")}`;
    const options = { ...f.options, roots: f.dispatch.roots,
      resolveWriteScope: (now: Date) => ({ ...f.options.resolveWriteScope(now)!, session_id: sessionId }) };
    const registered = registerMemoryScopedOutbox(options, f.claimed);
    const lease = claimMemoryScopedOutbox(options, registered.outbox_id, "worker:http", 1000)!;
    const dispatched = markMemoryScopedOutboxDispatch(options, lease, 30000);
    const policy = { schema_version: 3, provider_instance_id: "provider:fixture", principal_id: "principal:owner",
      policy_revision: "policy:1", valid_from: f.now.toISOString(), valid_until: dispatched.request.expires_at,
      agents: [{ agent_id: "agent:fixture", projects: ["project:a"], methods: ["sb_write_request"] }] };
    writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
    const headers = { Host: FIXTURE_HOST, "Tailscale-User-Login": FIXTURE_LOGIN, Origin: FIXTURE_ORIGIN,
      Cookie: `__Host-jarvis-phone=${cookie}`, "X-JARVIS-CSRF": csrf,
      "Content-Type": "application/json; charset=utf-8" };
    const body = canonicalize(dispatched.request);
    const call = (changed: Record<string, string> = {}, payload = body) => request(`${origin}/api/v1/memory/provider/verify`, {
      method: "POST", headers: { ...headers, ...changed }, body: payload });
    const before = f.database.authority.db.prepare("SELECT total_changes() AS n").get();
    at += 10;
    const normal = await call();
    expect(normal.statusCode).toBe(200);
    expect(await normal.body.json()).toMatchObject({ kind: "current_scoped_dispatch", outbox_id: registered.outbox_id,
      request_id: dispatched.request.request_id, dispatch_fence: lease.fence });
    for (const [changed, status] of [[{ Cookie: "" }, 401], [{ "X-JARVIS-CSRF": "wrong" }, 403]] as const) {
      const denied = await call(changed); expect(denied.statusCode).toBe(status); await denied.body.text();
    }
    const secondLogin = await request(`${origin}/api/v1/phone/session`, {
      headers: { Host: FIXTURE_HOST, "Tailscale-User-Login": FIXTURE_LOGIN } });
    const secondCookie = cookieFromSetCookie(secondLogin.headers["set-cookie"])!;
    const secondCsrf = (await secondLogin.body.json() as { csrf_token: string }).csrf_token;
    const otherSession = await call({ Cookie: `__Host-jarvis-phone=${secondCookie}`, "X-JARVIS-CSRF": secondCsrf });
    expect(otherSession.statusCode).toBe(403); await otherSession.body.text();
    const forged = await call({}, canonicalize({ ...dispatched.request, writer: { ...dispatched.request.writer, session_id: "session:forged" } }));
    expect(forged.statusCode).toBe(400); await forged.body.text();
    writeFileSync(policyPath, JSON.stringify({ ...policy, agents: [] }));
    const revoked = await call(); expect(revoked.statusCode).toBe(403); await revoked.body.text();
    // A successful verification must not move the original idle expiry by 10ms.
    at = f.now.getTime() + 15 * 60_000 + 5;
    const expired = await call(); expect(expired.statusCode).toBe(401); await expired.body.text();
    expect(f.database.authority.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(f.database.authority.db.prepare("SELECT state FROM memory_outbox").get()).toEqual({ state: "dispatching" });
    expect(f.database.authority.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(upstream.captures.some(row => row.url === "/api/v1/memory/provider/verify")).toBe(false);
    expect(audits.join("\n")).not.toContain(cookie);
    expect(audits.join("\n")).not.toContain(dispatched.request.request_id);
  } finally { gateway.close(); await upstream.close(); closeMemoryDatabase(f.database); rmSync(home.home, { recursive: true, force: true }); }
});
