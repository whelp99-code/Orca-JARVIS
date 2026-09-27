import { readFileSync } from "node:fs";
import { ControlPlane } from "../../src/control-plane.js";
import { parsePersonalOsPolicy } from "../../src/personal-os-policy.js";
import { RemoteApprovalService } from "../../src/remote-approval.js";
import { sha256Prefixed } from "../../src/remote-approval-crypto.js";
import { ControlReceiptSigner } from "../../src/remote-approval-signer.js";
import {
  FIXTURE_INGRESS_KEY,
  type RemoteIngressContextV1,
  type RemoteIngressResolver,
} from "../../src/remote-approval-types.js";
import { gatewaySessionDigest } from "../../src/remote-approval-crypto.js";
import { requestPath } from "../../src/dashboard/static-assets.js";
import type { AuthorityDb } from "../../src/db.js";
import { localKey } from "../helpers.js";
import type { ControlCommandRequestInput } from "../../src/control-plane.js";
import { future } from "../helpers.js";

export const REMOTE_ORIGIN = "https://jarvis-fixture.example.invalid";
export const REMOTE_RP_ID = "jarvis-fixture.example.invalid";
export const FIXTURE_OWNER_DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

export function fixtureSessionDigest(): `hmac-sha256:${string}` {
  return gatewaySessionDigest(FIXTURE_INGRESS_KEY, "phone-session-digest:fixture");
}

export function createFixtureResolver(): RemoteIngressResolver {
  return (request, body): RemoteIngressContextV1 | null => {
    const path = requestPath(request.url);
    if (path === undefined) return null;
    const admitted = path.startsWith("/api/v1/remote-approvals/")
      || path.startsWith("/api/v1/security/webauthn/registrations/");
    if (!admitted) return null;
    const method = request.method === "POST" ? "POST" : "GET";
    return {
      schema_version: 1,
      trust_mode: "gateway",
      gateway_owner_digest: FIXTURE_OWNER_DIGEST,
      gateway_session_digest: fixtureSessionDigest(),
      public_origin: REMOTE_ORIGIN,
      request_method: method,
      canonical_path: path,
      body_digest: sha256Prefixed(body),
      envelope_nonce_digest: sha256Prefixed("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      issued_at: "2026-08-31T00:00:00.000Z",
    };
  };
}

export function createRemoteService(db: AuthorityDb): RemoteApprovalService {
  const policy = parsePersonalOsPolicy(JSON.parse(readFileSync("config/personal-os-policy.json", "utf8")));
  const signer = new ControlReceiptSigner(localKey(db), "decision-test", "test-operator");
  return new RemoteApprovalService({
    db,
    control: new ControlPlane(db),
    policy,
    origin: REMOTE_ORIGIN,
    rpId: REMOTE_RP_ID,
    signer,
    signerSource: "file",
    resolver: createFixtureResolver(),
  });
}

export function workflowRequest(id: string, now = new Date()): ControlCommandRequestInput {
  return {
    schema_version: 1,
    request_id: id,
    action: "workflow.start",
    action_level: 2,
    target: { environment: "local" },
    args: {
      run_id: `run-${id}`,
      loop_id: "loop-remote",
      correlation_id: `corr-${id}`,
      input: {},
      budget: { max_tokens: 1 },
    },
    reversible: true,
    requested_by: "operator",
    requested_at: now.toISOString(),
    expires_at: future(10),
    nonce: `nonce-${id}`,
  };
}
