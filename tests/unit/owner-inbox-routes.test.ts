import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { controlCommandDigest, type ControlCommandRequestInput } from "../../src/control-plane-contract.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { issueEnrollmentCode } from "../../src/owner-inbox-enrollment.js";
import { OwnerInbox } from "../../src/owner-inbox.js";
import { ControlReceiptSigner } from "../../src/remote-approval-signer.js";
import { initialized, localKey } from "../helpers.js";

const NOW = new Date("2026-09-30T00:00:00.000Z");

function seed(db: Awaited<ReturnType<typeof initialized>>, id: string, action: string, expires = "2026-09-30T00:05:00.000Z"): string {
  const input: ControlCommandRequestInput = {
    schema_version: 1, request_id: id, action, action_level: 3, target: { candidate_id: id }, args: { note: "staged" },
    reversible: false, requested_by: "principal:owner", requested_at: NOW.toISOString(), expires_at: expires, nonce: `nonce:${id}`,
  };
  const digest = controlCommandDigest(input);
  db.db.prepare(
    `INSERT INTO control_command_requests(
      request_id, action, action_level, target_json, args_json, command_digest, reversible,
      requested_by, requested_at, expires_at, nonce, state, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?)`,
  ).run(id, action, 3, JSON.stringify(input.target), JSON.stringify(input.args), digest, 0, input.requested_by, input.requested_at, expires, input.nonce, input.requested_at);
  return digest;
}

async function boot(signerReady = true, keyId = "decision-test", enrollmentCheck?: (input: unknown) => Promise<{ ok: true; publicKey: Buffer; counter: number } | { ok: false }>) {
  const db = await initialized();
  const root = mkdtempSync(join(tmpdir(), "owner-inbox-route-"));
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  const inbox = new OwnerInbox(db, new ControlReceiptSigner(localKey(db), keyId, "test-operator"), signerReady, () => NOW);
  const server = createDashboardServer({
    db, staticRoot: root, host: "127.0.0.1", port: 0, clock: () => NOW, ownerInbox: inbox,
    assertionCheck: async (input) => input.assertion.id === "test-pass" && input.assertion.signature !== "bad"
      ? { ok: true, newCounter: 1 } : { ok: false },
    enrollmentCheck: enrollmentCheck as never,
  });
  const origin = `http://127.0.0.1:${server.address.port}`;
  const session = await request(`${origin}/api/v1/session`);
  const body = await session.body.json() as { csrf_token: string };
  const cookie = session.headers["set-cookie"];
  return { db, server, origin, csrf: body.csrf_token, cookie: Array.isArray(cookie) ? cookie[0] ?? "" : String(cookie ?? "") };
}

function headers(boot: { origin: string; csrf?: string; cookie?: string }, csrf = true): Record<string, string> {
  return {
    origin: boot.origin,
    host: new URL(boot.origin).host,
    "content-type": "application/json",
    ...(csrf && boot.csrf ? { "x-jarvis-csrf": boot.csrf } : {}),
    ...(boot.cookie ? { cookie: boot.cookie.split(";")[0] ?? "" } : {}),
  };
}

describe("owner inbox routes", () => {
  it("fails closed for each guard", async () => {
    const live = await boot();
    const digest = seed(live.db, "req-confirm", "memory.confirm");
    const oldDigest = seed(live.db, "req-old", "memory.confirm", "2026-09-29T00:00:00.000Z");
    const otherDigest = seed(live.db, "req-other", "workflow.start");
    live.db.db.prepare("INSERT INTO owner_inbox_credentials(credential_id, public_key, counter, created_at) VALUES(?,?,?,?)")
      .run("test-pass", Buffer.from("pk"), 0, NOW.toISOString());
    const decide = `${live.origin}/api/v1/owner-inbox/decide`;
    const unauth = await request(`${live.origin}/api/v1/owner-inbox`);
    expect(unauth.statusCode).toBe(401);
    const getDecide = await request(decide, { method: "GET", headers: headers(live) });
    expect(getDecide.statusCode).toBe(405);
    const noCsrf = await request(decide, { method: "POST", headers: headers(live, false), body: "{}" });
    expect(noCsrf.statusCode).toBe(401);
    const expired = await request(decide, { method: "POST", headers: headers(live), body: JSON.stringify({
      schema_version: 1, request_id: "req-old", decision: "approve", command_digest: oldDigest, challenge_id: "none",
    }) });
    expect(expired.statusCode).toBe(409);
    const forbidden = await request(decide, { method: "POST", headers: headers(live), body: JSON.stringify({
      schema_version: 1, request_id: "req-other", decision: "approve", command_digest: otherDigest, challenge_id: "none",
    }) });
    expect(forbidden.statusCode).toBe(403);
    const mismatch = await request(decide, { method: "POST", headers: headers(live), body: JSON.stringify({
      schema_version: 1, request_id: "req-confirm", decision: "approve", command_digest: "sha256:" + "b".repeat(64), challenge_id: "none",
    }) });
    expect(mismatch.statusCode).toBe(409);
    const missingChallenge = await request(`${live.origin}/api/v1/owner-inbox/challenge`, {
      method: "POST", headers: headers(live), body: JSON.stringify({
        schema_version: 1, request_id: "req-confirm", decision: "approve", command_digest: digest,
      }),
    });
    const missingChallengeBody = await missingChallenge.body.json() as { challenge_id: string };
    const missing = await request(decide, { method: "POST", headers: headers(live), body: JSON.stringify({
      schema_version: 1, request_id: "req-confirm", decision: "approve", command_digest: digest,
      challenge_id: missingChallengeBody.challenge_id,
    }) });
    expect(missing.statusCode).toBe(401);
    const issued = live.db && (await import("../../src/owner-inbox.js"));
    void issued;
    const challenge = await request(`${live.origin}/api/v1/owner-inbox/challenge`, { method: "POST", headers: headers(live), body: JSON.stringify({
      schema_version: 1, request_id: "req-confirm", decision: "approve", command_digest: digest,
    }) });
    const challengeBody = await challenge.body.json() as { challenge_id: string };
    const badAssertion = await request(decide, { method: "POST", headers: headers(live), body: JSON.stringify({
      schema_version: 1, request_id: "req-confirm", decision: "approve", command_digest: digest, challenge_id: challengeBody.challenge_id,
      assertion: { id: "test-pass", clientDataJSON: "", authenticatorData: "", signature: "bad", userHandle: "" },
    }) });
    expect(badAssertion.statusCode).toBe(401);
    const ok = await request(decide, { method: "POST", headers: headers(live), body: JSON.stringify({
      schema_version: 1, request_id: "req-confirm", decision: "approve", command_digest: digest, challenge_id: challengeBody.challenge_id,
      assertion: { id: "test-pass", clientDataJSON: "", authenticatorData: "", signature: "", userHandle: "" },
    }) });
    expect(ok.statusCode).toBe(200);
    const replay = await request(decide, { method: "POST", headers: headers(live), body: JSON.stringify({
      schema_version: 1, request_id: "req-confirm", decision: "approve", command_digest: digest, challenge_id: challengeBody.challenge_id,
      assertion: { id: "test-pass", clientDataJSON: "", authenticatorData: "", signature: "", userHandle: "" },
    }) });
    expect(replay.statusCode).toBe(401);
    const audits = live.db.db.prepare("SELECT COUNT(*) AS n FROM audit_facts WHERE fact_type='owner_inbox_attempt'").get() as { n: number };
    expect(audits.n).toBeGreaterThan(1);
    live.server.close();
    live.db.close();
  });

  it("leaves a pending request and writes an audit when the decision key does not match", async () => {
    const live = await boot(true, "wrong-key");
    const digest = seed(live.db, "req-confirm", "memory.confirm");
    live.db.db.prepare("INSERT INTO owner_inbox_credentials(credential_id, public_key, counter, created_at) VALUES(?,?,?,?)")
      .run("test-pass", Buffer.from("pk"), 0, NOW.toISOString());
    const challenge = await request(`${live.origin}/api/v1/owner-inbox/challenge`, { method: "POST", headers: headers(live), body: JSON.stringify({
      schema_version: 1, request_id: "req-confirm", decision: "approve", command_digest: digest,
    }) });
    const challengeBody = await challenge.body.json() as { challenge_id: string };
    const rejected = await request(`${live.origin}/api/v1/owner-inbox/decide`, { method: "POST", headers: headers(live), body: JSON.stringify({
      schema_version: 1, request_id: "req-confirm", decision: "approve", command_digest: digest, challenge_id: challengeBody.challenge_id,
      assertion: { id: "test-pass", clientDataJSON: "", authenticatorData: "", signature: "", userHandle: "" },
    }) });
    expect(rejected.statusCode).toBe(409);
    expect(live.db.db.prepare("SELECT state FROM control_command_requests WHERE request_id='req-confirm'").get()).toEqual({ state: "pending" });
    expect(live.db.db.prepare("SELECT COUNT(*) AS n FROM audit_facts WHERE fact_type='owner_inbox_attempt'").get()).toEqual({ n: 1 });
    live.server.close();
    live.db.close();
  });

  it("returns the stored challenge and enrolls once", async () => {
    const live = await boot(true, "decision-test", async () => ({ ok: true, publicKey: Buffer.from("pk"), counter: 1 }));
    const issued = issueEnrollmentCode(live.db, NOW);
    const options = await request(`${live.origin}/api/v1/owner-inbox/enroll`, {
      method: "POST", headers: headers(live), body: JSON.stringify({ schema_version: 1, enrollment_code: issued.code, phase: "options" }),
    });
    expect(options.statusCode).toBe(200);
    const optionsBody = await options.body.json() as { challenge: string; rp: { id: string } };
    const stored = live.db.db.prepare("SELECT challenge FROM owner_inbox_enrollment_codes").get() as { challenge: string };
    expect(optionsBody.challenge).toBe(stored.challenge);
    expect(optionsBody.rp.id).toBe("127.0.0.1");
    const enrolled = await request(`${live.origin}/api/v1/owner-inbox/enroll`, {
      method: "POST", headers: headers(live), body: JSON.stringify({
        schema_version: 1, enrollment_code: issued.code,
        attestation: { id: "cred", clientDataJSON: "e30", attestationObject: "e30" },
      }),
    });
    expect(enrolled.statusCode).toBe(200);
    expect(await enrolled.body.json()).toMatchObject({ credential_id: "cred" });
    const replay = await request(`${live.origin}/api/v1/owner-inbox/enroll`, {
      method: "POST", headers: headers(live), body: JSON.stringify({ schema_version: 1, enrollment_code: issued.code, phase: "options" }),
    });
    expect(replay.statusCode).toBe(401);
    expect(await replay.body.json()).toMatchObject({ error: { code: "OWNER_INBOX_REPLAY" } });
    const wrong = await request(`${live.origin}/api/v1/owner-inbox/enroll`, {
      method: "POST", headers: headers(live), body: JSON.stringify({ schema_version: 1, enrollment_code: "nope", phase: "options" }),
    });
    expect(wrong.statusCode).toBe(401);
    expect(await wrong.body.json()).toMatchObject({ error: { code: "OWNER_INBOX_IDENTITY_REQUIRED" } });
    const expiredCode = issueEnrollmentCode(live.db, new Date(NOW.getTime() - 11 * 60_000));
    const expired = await request(`${live.origin}/api/v1/owner-inbox/enroll`, {
      method: "POST", headers: headers(live), body: JSON.stringify({ schema_version: 1, enrollment_code: expiredCode.code, phase: "options" }),
    });
    expect(expired.statusCode).toBe(409);
    expect(await expired.body.json()).toMatchObject({ error: { code: "OWNER_INBOX_EXPIRED" } });
    const other = issueEnrollmentCode(live.db, NOW);
    process.env.JARVIS_OWNER_INBOX_ORIGIN = "https://phone.example";
    const origin = await request(`${live.origin}/api/v1/owner-inbox/enroll`, {
      method: "POST", headers: headers(live),
      body: JSON.stringify({ schema_version: 1, enrollment_code: other.code, phase: "options" }),
    });
    delete process.env.JARVIS_OWNER_INBOX_ORIGIN;
    expect(origin.statusCode).toBe(401);
    expect(await origin.body.json()).toMatchObject({ error: { code: "OWNER_INBOX_ORIGIN_MISMATCH" } });
    const originAudits = live.db.db.prepare(
      "SELECT COUNT(*) AS n FROM audit_facts WHERE fact_type='owner_inbox_attempt' AND payload_json LIKE '%OWNER_INBOX_ORIGIN_MISMATCH%'",
    ).get() as { n: number };
    expect(originAudits.n).toBeGreaterThan(0);
    live.server.close();
    live.db.close();
  });
});
