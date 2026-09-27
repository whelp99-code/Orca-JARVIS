import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt } from "../../src/control-plane.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { createDashboardSession, type DashboardSessionStore } from "../../src/dashboard/session.js";
import type { AuthorityDb } from "../../src/db.js";
import { createPhoneGatewayServer, parsePhoneGatewayConfig, type PhoneGatewayServer } from "../../src/phone-gateway.js";
import { initialized, localKey } from "../helpers.js";
import { FIXTURE_HOST, FIXTURE_LOGIN, FIXTURE_ORIGIN, cookieFromSetCookie, makePhoneHome, processUid } from "./phone-gateway-harness.js";

const REMOTE_ENV = [
  "JARVIS_REMOTE_PUBLIC_ORIGIN", "JARVIS_REMOTE_RP_ID", "JARVIS_DECISION_SIGNING_KEY_FILE", "JARVIS_REMOTE_INGRESS_KEY_FILE",
] as const;

export type GatewayJson = { readonly status: number; readonly body: Record<string, unknown> };

/**
 * The shipped composition: `createDashboardServer` with no injected service, so
 * `composeRemoteApproval` reads the remote env, a sealed decision key file and the
 * phone ingress key; a real `createPhoneGatewayServer` proxies to it. Both bind
 * ephemeral loopback ports.
 */
export class ProductionGatewayFixture {
  private phoneCookie: string | undefined;
  private phoneCsrf: string | undefined;

  private constructor(
    readonly db: AuthorityDb,
    readonly control: ControlPlane,
    readonly session: DashboardSessionStore,
    readonly dashboard: DashboardServer,
    readonly gateway: PhoneGatewayServer,
    private readonly roots: readonly string[],
    private readonly previousEnv: ReadonlyMap<string, string | undefined>,
    readonly clock: { current: Date; pinned: boolean },
    readonly publicOrigin: string,
  ) {}

  static async start(
    options: { readonly staticRoot?: string; readonly publicOrigin?: string } = {},
  ): Promise<ProductionGatewayFixture> {
    const publicOrigin = options.publicOrigin ?? FIXTURE_ORIGIN;
    const db = await initialized();
    const files = makePhoneHome(undefined, publicOrigin);
    const keyRoot = mkdtempSync(join(tmpdir(), "jarvis-decision-"));
    const decisionKey = join(keyRoot, "decision.pem");
    writeFileSync(decisionKey, localKey(db).export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    chmodSync(decisionKey, 0o600);
    const previousEnv = new Map<string, string | undefined>(REMOTE_ENV.map(name => [name, process.env[name]]));
    process.env.JARVIS_REMOTE_PUBLIC_ORIGIN = publicOrigin;
    process.env.JARVIS_REMOTE_RP_ID = FIXTURE_HOST;
    process.env.JARVIS_DECISION_SIGNING_KEY_FILE = decisionKey;
    process.env.JARVIS_REMOTE_INGRESS_KEY_FILE = files.keyFile;
    let staticRoot = options.staticRoot;
    if (staticRoot === undefined) {
      staticRoot = join(keyRoot, "static");
      mkdirSync(staticRoot);
      writeFileSync(join(staticRoot, "index.html"), "<!doctype html><html><head></head><body>security</body></html>");
    }
    const clock = { current: new Date(), pinned: false };
    const session = createDashboardSession();
    const dashboard = createDashboardServer({
      db, staticRoot, host: "127.0.0.1", port: 0, sessionStore: session,
      clock: () => clock.pinned ? clock.current : new Date(),
    });
    const gateway = createPhoneGatewayServer({
      host: "127.0.0.1", port: 0, upstream: `http://127.0.0.1:${String(dashboard.address.port)}`,
      staticRoot, config: parsePhoneGatewayConfig({ home: files.home, envFile: files.envFile, uid: processUid() }),
      audit: () => undefined,
    });
    return new ProductionGatewayFixture(
      db, new ControlPlane(db), session, dashboard, gateway, [files.home, keyRoot], previousEnv, clock, publicOrigin,
    );
  }

  /** The gateway validates `Host` against the public origin's authority, port included. */
  get publicHost(): string { return new URL(this.publicOrigin).host; }
  get localHost(): string { return `127.0.0.1:${String(this.dashboard.address.port)}`; }
  get localOrigin(): string { return `http://${this.localHost}`; }
  get gatewayUrl(): string { return `http://127.0.0.1:${String(this.gateway.address.port)}`; }

  now(): Date { return this.clock.pinned ? this.clock.current : new Date(); }

  async localPost(path: string, body: unknown): Promise<GatewayJson> {
    const response = await request(`${this.localOrigin}${path}`, {
      method: "POST",
      headers: {
        host: this.localHost, origin: this.localOrigin, "content-type": "application/json",
        "x-jarvis-csrf": this.session.snapshot().csrf_token,
      },
      body: JSON.stringify(body),
    });
    return { status: response.statusCode, body: await response.body.json() as Record<string, unknown> };
  }

  async localGet(path: string, headers: Record<string, string> = {}): Promise<GatewayJson> {
    const response = await request(`${this.localOrigin}${path}`, { headers: { host: this.localHost, ...headers } });
    return { status: response.statusCode, body: await response.body.json() as Record<string, unknown> };
  }

  /** Bootstraps the tailnet phone session once, the way the shell does before any route. */
  async phoneSession(): Promise<{ readonly cookie: string; readonly csrf: string }> {
    if (this.phoneCookie !== undefined && this.phoneCsrf !== undefined) return { cookie: this.phoneCookie, csrf: this.phoneCsrf };
    const response = await request(`${this.gatewayUrl}/api/v1/phone/session`, {
      headers: { Host: this.publicHost, "Tailscale-User-Login": FIXTURE_LOGIN },
    });
    const parsed = await response.body.json() as { csrf_token: string };
    const cookie = cookieFromSetCookie(response.headers["set-cookie"]);
    if (response.statusCode !== 200 || cookie === undefined) throw new Error(`phone session ${String(response.statusCode)}`);
    this.phoneCookie = cookie;
    this.phoneCsrf = parsed.csrf_token;
    return { cookie, csrf: parsed.csrf_token };
  }

  async gatewayJson(method: "GET" | "POST", path: string, body?: unknown): Promise<GatewayJson> {
    const phone = await this.phoneSession();
    const response = await request(`${this.gatewayUrl}${path}`, {
      method,
      headers: {
        Host: this.publicHost, "Tailscale-User-Login": FIXTURE_LOGIN, Origin: this.publicOrigin,
        Cookie: `__Host-jarvis-phone=${phone.cookie}`, "X-JARVIS-CSRF": phone.csrf,
        ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.statusCode, body: await response.body.json() as Record<string, unknown> };
  }

  async gatewayRaw(path: string, headers: Record<string, string> = {}): Promise<{ readonly status: number; readonly text: string; readonly type: string | undefined }> {
    const phone = await this.phoneSession();
    const response = await request(`${this.gatewayUrl}${path}`, {
      headers: { Host: this.publicHost, "Tailscale-User-Login": FIXTURE_LOGIN, Cookie: `__Host-jarvis-phone=${phone.cookie}`, ...headers },
    });
    const type = response.headers["content-type"];
    return { status: response.statusCode, text: await response.body.text(), type: typeof type === "string" ? type : undefined };
  }

  approveReceipt(requestId: string): CommandApprovalReceipt {
    const row = this.control.list().find(item => item.request_id === requestId);
    if (row === undefined) throw new Error(`request ${requestId}`);
    const now = this.now();
    return signCommandApproval({
      schema_version: 1, receipt_id: `rcpt-${row.request_id}`, request_id: row.request_id,
      decision: "approve", command_digest: row.command_digest, signer_principal_id: "test-operator",
      authenticated_session_id: `dashboard-session:${row.request_id}`, key_id: "decision-test",
      algorithm: "Ed25519", issued_at: now.toISOString(), not_before: now.toISOString(),
      expires_at: row.expires_at, nonce: `approval-${row.request_id}`, max_uses: 1, status: "issued",
    }, localKey(this.db));
  }

  async approveLocal(requestId: string): Promise<void> {
    const decided = await this.localPost(`/api/v1/control/requests/${requestId}/decision`, {
      schema_version: 1, receipt: this.approveReceipt(requestId),
    });
    if (decided.status !== 200) throw new Error(`decision ${requestId} ${String(decided.status)}`);
  }

  /** Local-session enrollment begin plus its owner approval; returns the ids the phone needs. */
  async beginEnrollment(): Promise<{ readonly enrollment_id: string; readonly request_id: string }> {
    const began = await this.localPost("/api/v1/security/webauthn/enrollments", { schema_version: 1 });
    if (began.status !== 200) throw new Error(`enroll ${String(began.status)}`);
    const enrollmentId = String(began.body.enrollment_id);
    const requestId = String(began.body.request_id);
    await this.approveLocal(requestId);
    return { enrollment_id: enrollmentId, request_id: requestId };
  }

  async activateCredential(credentialId: string, activationRequestId: string): Promise<void> {
    const activated = await this.localPost(`/api/v1/security/webauthn/credentials/${credentialId}/activate`, {
      schema_version: 1, receipt: this.approveReceipt(activationRequestId),
    });
    if (activated.status !== 200) throw new Error(`activate ${String(activated.status)}`);
  }

  ownerUserHandle(): Buffer {
    const owner = this.db.db.prepare("SELECT user_handle FROM remote_owner_principals_v2 WHERE singleton=1").get() as { user_handle: Buffer } | undefined;
    if (owner === undefined) throw new Error("owner principal");
    return owner.user_handle;
  }

  receiptCount(requestId: string): number {
    return (this.db.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts WHERE request_id=?").get(requestId) as { n: number }).n;
  }

  auditRows(requestId: string): Array<{ outcome: string; reason_code: string; up: number | null; uv: number | null }> {
    return this.db.db.prepare(
      "SELECT outcome, reason_code, up, uv FROM personal_operation_audit_events WHERE correlation_id=? AND event_type LIKE 'remote.%' ORDER BY created_at",
    ).all(requestId) as Array<{ outcome: string; reason_code: string; up: number | null; uv: number | null }>;
  }

  close(): void {
    this.gateway.close();
    this.dashboard.close();
    this.db.close();
    for (const [name, value] of this.previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const root of this.roots) rmSync(root, { recursive: true, force: true });
  }
}
