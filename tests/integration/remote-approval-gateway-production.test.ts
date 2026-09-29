import { describe, expect, it } from "vitest";
import { createP256Authenticator, signAssertion, signAttestation } from "../fixtures/webauthn-p256.js";
import { ProductionGatewayFixture } from "../fixtures/remote-approval-gateway-harness.js";
import { FIXTURE_HOST, FIXTURE_ORIGIN } from "../fixtures/phone-gateway-harness.js";
import { workflowRequest } from "../fixtures/remote-approval-support.js";

type RemoteAuditRow = {
  readonly outcome: string;
  readonly reason_code: string;
  readonly credential_digest_prefix: string | null;
  readonly assertion_digest: string | null;
};

function remoteAudits(fixture: ProductionGatewayFixture): readonly RemoteAuditRow[] {
  return fixture.db.db.prepare(
    "SELECT outcome, reason_code, credential_digest_prefix, assertion_digest FROM personal_operation_audit_events WHERE event_type LIKE 'remote.%' ORDER BY created_at, event_id",
  ).all() as RemoteAuditRow[];
}

function credentialCount(fixture: ProductionGatewayFixture): number {
  return (fixture.db.db.prepare("SELECT COUNT(*) AS n FROM webauthn_credentials_v2").get() as { n: number }).n;
}

async function issueRegistration(fixture: ProductionGatewayFixture): Promise<{ readonly ceremonyId: string; readonly challenge: string }> {
  const began = await fixture.beginEnrollment();
  const options = await fixture.gatewayJson("POST", `/api/v1/security/webauthn/registrations/${began.enrollment_id}/options`, {
    schema_version: 1, begin_request_id: began.request_id,
  });
  expect(options.status, JSON.stringify(options.body)).toBe(200);
  return {
    ceremonyId: String(options.body.ceremony_id),
    challenge: String((options.body.options as { challenge: string }).challenge),
  };
}

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
      expect(credentialCount(fixture)).toBe(0);
      expect(remoteAudits(fixture)).toEqual([
        expect.objectContaining({ outcome: "rejected", reason_code: "missing", credential_digest_prefix: null, assertion_digest: null }),
      ]);
    } finally {
      fixture.close();
    }
  });

  it("writes one audit and no credential when registration verify uses another owner's ceremony", async () => {
    const fixture = await ProductionGatewayFixture.start();
    try {
      const issued = await issueRegistration(fixture);
      const authenticator = createP256Authenticator(fixture.ownerUserHandle());
      fixture.db.db.prepare("UPDATE webauthn_registration_ceremonies_v2 SET principal_id=? WHERE ceremony_id=?")
        .run("rpr_other_owner", issued.ceremonyId);
      const refused = await fixture.gatewayJson("POST", `/api/v1/security/webauthn/registrations/${issued.ceremonyId}/verify`, {
        schema_version: 1,
        credential: signAttestation({ authenticator, rpId: FIXTURE_HOST, origin: FIXTURE_ORIGIN, challengeB64: issued.challenge }),
      });
      expect(refused.status).toBe(403);
      expect(credentialCount(fixture)).toBe(0);
      expect(remoteAudits(fixture)).toEqual([
        expect.objectContaining({ outcome: "rejected", reason_code: "principal", credential_digest_prefix: null, assertion_digest: null }),
      ]);
      const ceremony = fixture.db.db.prepare("SELECT state, terminal_reason FROM webauthn_registration_ceremonies_v2 WHERE ceremony_id=?").get(issued.ceremonyId) as { state: string; terminal_reason: string };
      expect(ceremony).toEqual({ state: "rejected", terminal_reason: "principal" });
    } finally {
      fixture.close();
    }
  });

  it("commits expiry and one audit when registration verify arrives after the ceremony expired", async () => {
    const fixture = await ProductionGatewayFixture.start();
    try {
      const issued = await issueRegistration(fixture);
      fixture.db.db.prepare(
        "UPDATE webauthn_registration_ceremonies_v2 SET issued_at=?, expires_at=? WHERE ceremony_id=?",
      ).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z", issued.ceremonyId);
      const refused = await fixture.gatewayJson("POST", `/api/v1/security/webauthn/registrations/${issued.ceremonyId}/verify`, {
        schema_version: 1, credential: { id: "x" },
      });
      expect(refused.status).toBe(409);
      expect(credentialCount(fixture)).toBe(0);
      const ceremony = fixture.db.db.prepare("SELECT state, terminal_reason FROM webauthn_registration_ceremonies_v2 WHERE ceremony_id=?").get(issued.ceremonyId) as { state: string; terminal_reason: string | null };
      expect(ceremony).toEqual({ state: "expired", terminal_reason: "expired" });
      expect(remoteAudits(fixture)).toEqual([
        expect.objectContaining({ outcome: "expired", reason_code: "expired", credential_digest_prefix: null, assertion_digest: null }),
      ]);
    } finally {
      fixture.close();
    }
  });

  it("writes one audit and no second credential when registration verify is replayed", async () => {
    const fixture = await ProductionGatewayFixture.start();
    try {
      const issued = await issueRegistration(fixture);
      const authenticator = createP256Authenticator(fixture.ownerUserHandle());
      const attestation = signAttestation({
        authenticator, rpId: FIXTURE_HOST, origin: FIXTURE_ORIGIN, challengeB64: issued.challenge,
      });
      const first = await fixture.gatewayJson("POST", `/api/v1/security/webauthn/registrations/${issued.ceremonyId}/verify`, {
        schema_version: 1, credential: attestation,
      });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const before = credentialCount(fixture);
      const replayed = await fixture.gatewayJson("POST", `/api/v1/security/webauthn/registrations/${issued.ceremonyId}/verify`, {
        schema_version: 1, credential: attestation,
      });
      expect(replayed.status).toBe(409);
      expect(credentialCount(fixture)).toBe(before);
      expect(remoteAudits(fixture)).toEqual([
        expect.objectContaining({ outcome: "rejected", reason_code: "consumed", credential_digest_prefix: null, assertion_digest: null }),
      ]);
    } finally {
      fixture.close();
    }
  });

  it("rejects a modified approval argument as a binding failure with one audit and zero receipts", async () => {
    const fixture = await ProductionGatewayFixture.start();
    try {
      const { authenticator } = await enrollThroughGateway(fixture);
      const staged = fixture.control.stage(workflowRequest("gw-prod-modified-arg", fixture.now()), fixture.now());
      const issued = await fixture.gatewayJson("POST", `/api/v1/remote-approvals/${staged.request_id}/options`, {
        schema_version: 1, decision: "approve",
      });
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
      fixture.db.db.exec("DROP TRIGGER IF EXISTS control_request_identity_immutable");
      fixture.db.db.prepare("UPDATE control_command_requests SET args_json=? WHERE request_id=?")
        .run(JSON.stringify({ ...staged.args, budget: { max_tokens: 2 } }), staged.request_id);
      const challengeId = String(issued.body.challenge_id);
      const refused = await fixture.gatewayJson("POST", `/api/v1/remote-approvals/${challengeId}/verify`, {
        schema_version: 1,
        credential: signAssertion({
          authenticator, rpId: FIXTURE_HOST, origin: FIXTURE_ORIGIN,
          challengeB64: String((issued.body.options as { challenge: string }).challenge), counter: 1,
        }),
      });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ error: { code: "REMOTE_CEREMONY_REJECTED" } });
      expect(fixture.receiptCount(staged.request_id)).toBe(0);
      expect(fixture.auditRows(staged.request_id)).toEqual([
        expect.objectContaining({ outcome: "rejected", reason_code: "binding" }),
      ]);
    } finally {
      fixture.close();
    }
  });
});
