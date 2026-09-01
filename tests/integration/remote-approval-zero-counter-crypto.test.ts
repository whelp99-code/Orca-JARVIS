import { describe, expect, it } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { initialized } from "../helpers.js";
import { createP256Authenticator, signAssertion } from "../fixtures/webauthn-p256.js";
import { createRemoteService, REMOTE_ORIGIN, REMOTE_RP_ID, workflowRequest } from "../fixtures/remote-approval-support.js";
import { createFixtureResolver } from "../fixtures/remote-approval-support.js";
import { IncomingMessage } from "node:http";

function fakeRequest(path: string, method: "GET" | "POST"): IncomingMessage {
  return { url: path, method, headers: {}, rawHeaders: [] } as unknown as IncomingMessage;
}

describe("zero-counter cryptographic assertion", () => {
  it("verifies and translates a manually signed P-256 assertion whose counter stays 0", async () => {
    const db = await initialized();
    const control = new ControlPlane(db);
    const now = new Date();
    const staged = control.stage(workflowRequest("zero-counter", now), now);
    const service = createRemoteService(db);
    const owner = service.ensureOwner(now);
    const authenticator = createP256Authenticator(owner.user_handle);
    service.installActiveCredential({
      credential_id: authenticator.credentialIdB64, public_key_cose: authenticator.coseKey,
      algorithm: -7, sign_count: 0, backup_eligible: 0, backup_state: 0, now,
    });
    const resolver = createFixtureResolver();
    const optionsReq = fakeRequest(`/api/v1/remote-approvals/${staged.request_id}/options`, "POST");
    const optionsBody = Buffer.from(JSON.stringify({ schema_version: 1, decision: "approve" }));
    const ingress = resolver(optionsReq, optionsBody);
    if (ingress === null) throw new Error("ingress");
    const issued = service.issueOptions(staged.request_id, { schema_version: 1, decision: "approve" }, ingress, now);
    const assertion = signAssertion({
      authenticator, rpId: REMOTE_RP_ID, origin: REMOTE_ORIGIN, challengeB64: String(issued.options.challenge), counter: 0,
    });
    const verifyReq = fakeRequest(`/api/v1/remote-approvals/${issued.challenge_id}/verify`, "POST");
    const raw = Buffer.from(JSON.stringify({ schema_version: 1, credential: assertion }));
    const verifyIngress = resolver(verifyReq, raw);
    if (verifyIngress === null) throw new Error("verify ingress");
    const translated = await service.verify(issued.challenge_id, raw, verifyIngress, now);
    expect(translated.decision).toBe("approve");
    expect((db.db.prepare("SELECT sign_count,counter_mode FROM webauthn_credentials_v2 WHERE credential_id=?").get(authenticator.credentialIdB64) as { sign_count: number; counter_mode: string })).toEqual({ sign_count: 0, counter_mode: "zero" });
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts").get() as { n: number }).n).toBe(1);
    db.close();
  });
});
