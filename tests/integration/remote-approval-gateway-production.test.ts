import { describe, expect, it } from "vitest";
import { createP256Authenticator, signAssertion, signAttestation } from "../fixtures/webauthn-p256.js";
import { ProductionGatewayFixture } from "../fixtures/remote-approval-gateway-harness.js";
import { FIXTURE_HOST, FIXTURE_ORIGIN } from "../fixtures/phone-gateway-harness.js";
import { workflowRequest } from "../fixtures/remote-approval-support.js";

async function enrollThroughGateway(fixture: ProductionGatewayFixture): Promise<{
  readonly authenticator: ReturnType<typeof createP256Authenticator>;
  readonly credentialId: string;
  readonly credentialIdDigestPrefix: string;
}> {
  const began = await fixture.beginEnrollment();
  const authenticator = createP256Authenticator(fixture.ownerUserHandle());
  const options = await fixture.gatewayJson("POST", `/api/v1/security/webauthn/registrations/${began.enrollment_id}/options`, {
    schema_version: 1, begin_request_id: began.request_id,
  });
  expect(options.status, JSON.stringify(options.body)).toBe(200);
  const ceremonyId = String(options.body.ceremony_id);
  const challenge = String((options.body.options as { challenge: string }).challenge);
  const verified = await fixture.gatewayJson("POST", `/api/v1/security/webauthn/registrations/${ceremonyId}/verify`, {
    schema_version: 1,
    credential: signAttestation({ authenticator, rpId: FIXTURE_HOST, origin: FIXTURE_ORIGIN, challengeB64: challenge }),
  });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  const credentialId = String(verified.body.credential_id);
  expect(credentialId).toBe(authenticator.credentialIdB64);
  const pending = fixture.db.db.prepare("SELECT state, credential_id_digest FROM webauthn_credentials_v2 WHERE credential_id=?").get(credentialId) as { state: string; credential_id_digest: string };
  expect(pending.state).toBe("pending");
  await fixture.activateCredential(credentialId, String(verified.body.activation_request_id));
  const active = fixture.db.db.prepare("SELECT state FROM webauthn_credentials_v2 WHERE credential_id=?").get(credentialId) as { state: string };
  expect(active.state).toBe("active");
  return { authenticator, credentialId, credentialIdDigestPrefix: pending.credential_id_digest.slice(7, 23) };
}

describe("production composition behind the real phone gateway", () => {
  it("enrolls locally, registers the passkey through the gateway, then approves exactly once", async () => {
    const fixture = await ProductionGatewayFixture.start();
    try {
      const { authenticator } = await enrollThroughGateway(fixture);
      const staged = fixture.control.stage(workflowRequest("gw-prod-approve", fixture.now()), fixture.now());
      const issued = await fixture.gatewayJson("POST", `/api/v1/remote-approvals/${staged.request_id}/options`, {
        schema_version: 1, decision: "approve",
      });
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
      const challengeId = String(issued.body.challenge_id);
      const assertion = signAssertion({
        authenticator, rpId: FIXTURE_HOST, origin: FIXTURE_ORIGIN,
        challengeB64: String((issued.body.options as { challenge: string }).challenge), counter: 1,
      });
      const decided = await fixture.gatewayJson("POST", `/api/v1/remote-approvals/${challengeId}/verify`, {
        schema_version: 1, credential: assertion,
      });
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      expect(fixture.receiptCount(staged.request_id)).toBe(1);
      const claimed = fixture.control.claim(staged.request_id, "gateway-production-worker", fixture.now());
      expect(claimed.request_id).toBe(staged.request_id);
      expect(() => fixture.control.claim(staged.request_id, "gateway-production-worker", fixture.now())).toThrow();
      expect(fixture.auditRows(staged.request_id).map(row => row.outcome)).toEqual(["translated"]);
    } finally {
      fixture.close();
    }
  });

  it("lists the active passkey on the local origin and through the gateway", async () => {
    const fixture = await ProductionGatewayFixture.start();
    try {
      const { credentialIdDigestPrefix } = await enrollThroughGateway(fixture);
      const csrf = fixture.session.snapshot().csrf_token;

      const local = await fixture.localGet("/api/v1/security/webauthn/credentials", { "x-jarvis-csrf": csrf });
      expect(local.status, JSON.stringify(local.body)).toBe(200);
      expect(local.body.items).toEqual([{ credential_id_prefix: credentialIdDigestPrefix, state: "active" }]);

      const gateway = await fixture.gatewayJson("GET", "/api/v1/security/webauthn/credentials");
      expect(gateway.status, JSON.stringify(gateway.body)).toBe(200);
      expect(gateway.body.items).toEqual([{ credential_id_prefix: credentialIdDigestPrefix, state: "active" }]);

      const noCsrf = await fixture.localGet("/api/v1/security/webauthn/credentials");
      expect(noCsrf.status).toBe(403);
      const foreignOrigin = await fixture.localGet("/api/v1/security/webauthn/credentials", {
        "x-jarvis-csrf": csrf, origin: "http://evil.example.invalid",
      });
      expect(foreignOrigin.status).toBe(403);
    } finally {
      fixture.close();
    }
  });

  it("refuses ingress for a staged request whose stored args no longer hash to its command digest", async () => {
    const fixture = await ProductionGatewayFixture.start();
    try {
      const staged = fixture.control.stage(workflowRequest("gw-prod-tampered", fixture.now()), fixture.now());
      fixture.db.db.exec("DROP TRIGGER IF EXISTS control_request_identity_immutable");
      fixture.db.db.prepare("UPDATE control_command_requests SET args_json=? WHERE request_id=?")
        .run(JSON.stringify({ ...staged.args, budget: { max_tokens: 2 } }), staged.request_id);
      const refused = await fixture.gatewayJson("POST", `/api/v1/remote-approvals/${staged.request_id}/options`, {
        schema_version: 1, decision: "approve",
      });
      expect(refused.status).toBe(401);
      expect((fixture.db.db.prepare("SELECT COUNT(*) AS n FROM webauthn_approval_challenges_v2").get() as { n: number }).n).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("refuses registration verify for a ceremony id that no local enrollment owns", async () => {
    const fixture = await ProductionGatewayFixture.start();
    try {
      const refused = await fixture.gatewayJson("POST", "/api/v1/security/webauthn/registrations/rgy_unknown/verify", {
        schema_version: 1, credential: { id: "x" },
      });
      expect(refused.status).toBe(401);
      expect((fixture.db.db.prepare("SELECT COUNT(*) AS n FROM webauthn_credentials_v2").get() as { n: number }).n).toBe(0);
    } finally {
      fixture.close();
    }
  });
});
