import { execFileSync } from "node:child_process";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "undici";
import type { Page } from "@playwright/test";
import { ControlPlane, signCommandApproval } from "../src/control-plane.js";
import { createDashboardServer, type DashboardServer } from "../src/dashboard/server.js";
import { createDashboardSession, type DashboardSessionStore } from "../src/dashboard/session.js";
import { requestPath } from "../src/dashboard/static-assets.js";
import type { AuthorityDb } from "../src/db.js";
import { parsePersonalOsPolicy } from "../src/personal-os-policy.js";
import { RemoteApprovalService } from "../src/remote-approval.js";
import { sha256Prefixed } from "../src/remote-approval-crypto.js";
import { ControlReceiptSigner } from "../src/remote-approval-signer.js";
import type { RemoteIngressContextV1 } from "../src/remote-approval-types.js";
import {
  FIXTURE_OWNER_DIGEST, fixtureSessionDigest, workflowRequest,
} from "../tests/fixtures/remote-approval-support.js";
import { initialized, localKey } from "../tests/helpers.js";
import { createResidentCredential, type CredentialJson } from "./remote-approval-cdp.js";

export const FIXTURE_RP_ID = "jarvis-fixture.example.invalid";

export class RemoteApprovalFixture {
  private constructor(
    readonly origin: string,
    readonly tlsPort: number,
    readonly httpHost: string,
    readonly db: AuthorityDb,
    readonly control: ControlPlane,
    readonly service: RemoteApprovalService,
    private readonly session: DashboardSessionStore,
    private readonly dashboard: DashboardServer,
    private readonly tls: HttpsServer,
    private readonly certDir: string,
    readonly clock: { current: Date; pinned: boolean },
  ) {}

  static async start(): Promise<RemoteApprovalFixture> {
    const certDir = mkdtempSync(join(tmpdir(), "jarvis-remote-tls-"));
    const keyPath = join(certDir, "key.pem");
    const certPath = join(certDir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1", "-nodes",
      "-subj", `/CN=${FIXTURE_RP_ID}`, "-addext", `subjectAltName=DNS:${FIXTURE_RP_ID}`,
      "-keyout", keyPath, "-out", certPath,
    ], { stdio: "pipe" });
    const routing = { httpPort: 0 };
    const tls = createHttpsServer({
      key: readFileSync(keyPath), cert: readFileSync(certPath),
    }, (incoming, outgoing) => proxyToLoopback(incoming, outgoing, routing.httpPort));
    await listenLoopback(tls);
    const tlsAddress = tls.address();
    if (tlsAddress === null || typeof tlsAddress === "string" || tlsAddress.port < 1024) {
      tls.close();
      throw new Error("tls port");
    }
    const origin = `https://${FIXTURE_RP_ID}:${String(tlsAddress.port)}`;
    const db = await initialized();
    const session = createDashboardSession();
    const service = composeService(db, origin);
    const clock = { current: new Date(), pinned: false };
    const dashboard = createDashboardServer({
      db, staticRoot: resolve("dist/dashboard"), host: "127.0.0.1", port: 0,
      sessionStore: session, remoteApproval: service, clock: () => clock.pinned ? clock.current : new Date(),
    });
    routing.httpPort = dashboard.address.port;
    return new RemoteApprovalFixture(
      origin, tlsAddress.port, `127.0.0.1:${String(dashboard.address.port)}`,
      db, new ControlPlane(db), service, session, dashboard, tls, certDir, clock,
    );
  }

  async enrollResident(page: Page): Promise<string> {
    const began = await this.localPost("/api/v1/security/webauthn/enrollments", { schema_version: 1 });
    const enrollmentId = text(began, "enrollment_id");
    const beginId = text(began, "request_id");
    await this.decide(beginId);
    const options = await this.remotePost(page, `/api/v1/security/webauthn/registrations/${enrollmentId}/options`, {
      schema_version: 1, begin_request_id: beginId,
    });
    const ceremonyId = text(options, "ceremony_id");
    const publicKey = options.options;
    if (typeof publicKey !== "object" || publicKey === null) throw new Error("reg options");
    const attestation = await createResidentCredential(page, publicKey as Record<string, unknown>);
    const verified = await this.remotePost(page, `/api/v1/security/webauthn/registrations/${ceremonyId}/verify`, {
      schema_version: 1, credential: attestation,
    });
    const credentialId = text(verified, "credential_id");
    const activationId = text(verified, "activation_request_id");
    await this.localPost(`/api/v1/security/webauthn/credentials/${credentialId}/activate`, {
      schema_version: 1, receipt: this.approve(activationId),
    });
    return credentialId;
  }

  async issueOptions(page: Page, requestId: string, decision: "approve" | "reject"): Promise<{
    readonly challenge_id: string; readonly options: Record<string, unknown>;
  }> {
    const body = await this.remotePost(page, `/api/v1/remote-approvals/${requestId}/options`, {
      schema_version: 1, decision,
    });
    const options = body.options;
    if (typeof options !== "object" || options === null) throw new Error("options");
    return { challenge_id: text(body, "challenge_id"), options: options as Record<string, unknown> };
  }

  verifyAssertion(page: Page, challengeId: string, credential: CredentialJson): Promise<Record<string, unknown>> {
    return this.remotePost(page, `/api/v1/remote-approvals/${challengeId}/verify`, {
      schema_version: 1, credential,
    }, true);
  }

  stageWorkflow(id: string) {
    return this.control.stage(workflowRequest(id, new Date()), new Date());
  }

  receiptCount(requestId?: string): number {
    if (requestId === undefined) {
      return (this.db.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts").get() as { n: number }).n;
    }
    return (this.db.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts WHERE request_id=?").get(requestId) as { n: number }).n;
  }

  private now(): Date {
    return this.clock.pinned ? this.clock.current : new Date();
  }

  claim(requestId: string) {
    return this.control.claim(requestId, "remote-e2e-worker", this.now());
  }

  stage(id: string) {
    const now = this.now();
    return this.control.stage(workflowRequest(id, now), now);
  }

  async beginEnrollment(): Promise<{ readonly enrollment_id: string; readonly request_id: string }> {
    const began = await this.localPost("/api/v1/security/webauthn/enrollments", { schema_version: 1 });
    return { enrollment_id: text(began, "enrollment_id"), request_id: text(began, "request_id") };
  }

  async approveLocal(requestId: string): Promise<void> {
    await this.localPost(`/api/v1/control/requests/${requestId}/decision`, {
      schema_version: 1, receipt: this.approve(requestId),
    });
  }

  async activateCredential(credentialId: string, requestId: string): Promise<void> {
    await this.localPost(`/api/v1/security/webauthn/credentials/${credentialId}/activate`, {
      schema_version: 1, receipt: this.approve(requestId),
    });
  }

  pendingCredential(): { readonly credential_id: string; readonly activation_request_id: string } {
    return this.db.db.prepare(
      "SELECT credential_id, activation_request_id FROM webauthn_credentials_v2 WHERE state='pending' ORDER BY created_at DESC LIMIT 1",
    ).get() as { credential_id: string; activation_request_id: string };
  }

  auditCount(requestId: string): number {
    return (this.db.db.prepare(
      "SELECT COUNT(*) AS n FROM personal_operation_audit_events WHERE correlation_id=? AND event_type LIKE 'remote.%'",
    ).get(requestId) as { n: number }).n;
  }

  async revoke(credentialId: string): Promise<void> {
    const staged = await this.localPost(`/api/v1/security/webauthn/credentials/${credentialId}/revocation-requests`, {
      schema_version: 1, reason: "lost device",
    });
    const requestId = text(staged, "request_id");
    await this.localPost(`/api/v1/security/webauthn/credentials/${credentialId}/revoke`, {
      schema_version: 1, receipt: this.approve(requestId),
    });
  }

  tamperArgs(requestId: string): void {
    this.db.db.exec("DROP TRIGGER IF EXISTS control_request_identity_immutable");
    const row = this.db.db.prepare("SELECT args_json FROM control_command_requests WHERE request_id=?").get(requestId) as { args_json: string };
    const args = JSON.parse(row.args_json) as { budget?: { max_tokens?: number } };
    const budget = args.budget ?? {};
    budget.max_tokens = (budget.max_tokens ?? 1) + 1;
    args.budget = budget;
    this.db.db.prepare("UPDATE control_command_requests SET args_json=? WHERE request_id=?").run(JSON.stringify(args), requestId);
  }

  async close(): Promise<void> {
    this.dashboard.close();
    this.tls.closeAllConnections();
    await closeTls(this.tls);
    this.db.close();
    rmSync(this.certDir, { recursive: true, force: true });
  }

  private async decide(requestId: string): Promise<void> {
    await this.localPost(`/api/v1/control/requests/${requestId}/decision`, {
      schema_version: 1, receipt: this.approve(requestId),
    });
  }

  private approve(requestId: string) {
    const row = this.control.list().find(item => item.request_id === requestId);
    if (row === undefined) throw new Error("request");
    const now = this.clock.pinned ? this.clock.current : new Date();
    return signCommandApproval({
      schema_version: 1, receipt_id: `rcpt-${row.request_id}`, request_id: row.request_id,
      decision: "approve", command_digest: row.command_digest, signer_principal_id: "test-operator",
      authenticated_session_id: `dashboard-session:${row.request_id}`, key_id: "decision-test",
      algorithm: "Ed25519", issued_at: now.toISOString(), not_before: now.toISOString(),
      expires_at: row.expires_at, nonce: `approval-${row.request_id}`, max_uses: 1, status: "issued",
    }, localKey(this.db));
  }

  private async localPost(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await request(`http://${this.httpHost}${path}`, {
      method: "POST",
      headers: {
        host: this.httpHost, origin: `http://${this.httpHost}`, "content-type": "application/json",
        "x-jarvis-csrf": this.session.snapshot().csrf_token,
      },
      body: JSON.stringify(body),
    });
    const parsed: unknown = await res.body.json();
    if (res.statusCode >= 400 || typeof parsed !== "object" || parsed === null) {
      throw new Error(`local ${path} ${String(res.statusCode)}`);
    }
    return parsed as Record<string, unknown>;
  }

  private async remotePost(
    page: Page, path: string, body: unknown, allowError = false,
  ): Promise<Record<string, unknown>> {
    const posted = await page.evaluate(async input => {
      const res = await fetch(`${input.origin}${input.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.body),
      });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    }, { origin: this.origin, path, body });
    if (!allowError && posted.status >= 400) throw new Error(`remote ${path} ${String(posted.status)}`);
    return { ...posted.body, http_status: posted.status };
  }
}

function composeService(db: AuthorityDb, origin: string): RemoteApprovalService {
  const policy = parsePersonalOsPolicy(JSON.parse(readFileSync("config/personal-os-policy.json", "utf8")));
  const signer = new ControlReceiptSigner(localKey(db), "decision-test", "test-operator");
  return new RemoteApprovalService({
    db, control: new ControlPlane(db), policy, origin, rpId: FIXTURE_RP_ID, signer, signerSource: "file",
    resolver: (request, body): RemoteIngressContextV1 | null => {
      const path = requestPath(request.url);
      if (path === undefined) return null;
      if (!path.startsWith("/api/v1/remote-approvals/") && !path.startsWith("/api/v1/security/webauthn/registrations/")) {
        return null;
      }
      return {
        schema_version: 1, trust_mode: "gateway",
        gateway_owner_digest: FIXTURE_OWNER_DIGEST, gateway_session_digest: fixtureSessionDigest(),
        public_origin: origin, request_method: request.method === "POST" ? "POST" : "GET",
        canonical_path: path, body_digest: sha256Prefixed(body),
        envelope_nonce_digest: sha256Prefixed("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
        issued_at: "2026-08-31T00:00:00.000Z",
      };
    },
  });
}

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(key);
  return value;
}

function proxyToLoopback(incoming: IncomingMessage, outgoing: ServerResponse, httpPort: number): void {
  if (httpPort < 1024) {
    outgoing.writeHead(503);
    outgoing.end();
    return;
  }
  const headers = { ...incoming.headers, host: `127.0.0.1:${String(httpPort)}` };
  const upstream = httpRequest({
    hostname: "127.0.0.1", port: httpPort, path: incoming.url, method: incoming.method, headers,
  }, response => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  upstream.on("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(upstream);
}

function listenLoopback(server: HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeTls(server: HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}
