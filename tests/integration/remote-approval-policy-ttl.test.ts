import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ControlPlane } from "../../src/control-plane.js";
import { parsePersonalOsPolicy } from "../../src/personal-os-policy.js";
import { RemoteApprovalService } from "../../src/remote-approval.js";
import { ControlReceiptSigner } from "../../src/remote-approval-signer.js";
import { initialized, localKey } from "../helpers.js";
import {
  createFixtureResolver, REMOTE_ORIGIN, REMOTE_RP_ID, workflowRequest, fixtureSessionDigest, FIXTURE_OWNER_DIGEST,
} from "../fixtures/remote-approval-support.js";
import { sha256Prefixed } from "../../src/remote-approval-crypto.js";

describe("remote approval policy TTL", () => {
  it("expires a challenge at the policy TTL rather than a hardcoded five minutes", async () => {
    const db = await initialized();
    try {
      const parsed = parsePersonalOsPolicy(JSON.parse(readFileSync("config/personal-os-policy.json", "utf8")));
      const now = new Date();
      const service = new RemoteApprovalService({
        db, control: new ControlPlane(db), origin: REMOTE_ORIGIN, rpId: REMOTE_RP_ID,
        signer: new ControlReceiptSigner(localKey(db), "decision-test", "test-operator"),
        signerSource: "file", resolver: createFixtureResolver(),
        policy: { owner_principal: parsed.owner_principal, remote_approval: { ...parsed.remote_approval, challenge_ttl_seconds: 60 } },
      });
      const staged = new ControlPlane(db).stage(workflowRequest("ttl-60", now), now);
      const ingress = {
        schema_version: 1 as const, trust_mode: "gateway" as const, gateway_owner_digest: FIXTURE_OWNER_DIGEST,
        gateway_session_digest: fixtureSessionDigest(), public_origin: REMOTE_ORIGIN, request_method: "POST" as const,
        canonical_path: `/api/v1/remote-approvals/${staged.request_id}/options`,
        body_digest: sha256Prefixed(Buffer.alloc(0)), envelope_nonce_digest: sha256Prefixed("n"),
        issued_at: now.toISOString(),
      };
      service.issueOptions(staged.request_id, { schema_version: 1, decision: "approve" }, ingress, now);
      const row = db.db.prepare("SELECT expires_at FROM webauthn_approval_challenges_v2 WHERE request_id=?").get(staged.request_id) as { expires_at: string };
      expect(Date.parse(row.expires_at) - now.getTime()).toBe(60_000);
    } finally {
      db.close();
    }
  });
});
