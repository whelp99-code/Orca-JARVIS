import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test as base } from "@playwright/test";
import { FIXTURE_HOST, FIXTURE_LOGIN, FIXTURE_ORIGIN } from "../tests/fixtures/phone-gateway-harness.js";
import { ProductionGatewayFixture } from "../tests/fixtures/remote-approval-gateway-harness.js";

/** A tailnet client address, so the emulated Serve trio passes the gateway's peer check. */
const SERVE_CLIENT = "100.100.100.100";

type ServeFront = {
  readonly port: number;
  readonly route: { gatewayPort: number };
  close(): Promise<void>;
};

/**
 * A TLS listener that injects exactly what Tailscale Serve injects, then forwards
 * to whichever gateway the current test started. It binds an ephemeral loopback
 * port; the browser reaches it because the worker maps the fixture host's :443 here,
 * which keeps the page origin port-free — the only shape the gateway config accepts.
 */
async function startServeFront(): Promise<ServeFront> {
  const certDir = mkdtempSync(join(tmpdir(), "jarvis-gateway-tls-"));
  const keyPath = join(certDir, "key.pem");
  const certPath = join(certDir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1", "-nodes",
    "-subj", `/CN=${FIXTURE_HOST}`, "-addext", `subjectAltName=DNS:${FIXTURE_HOST}`,
    "-keyout", keyPath, "-out", certPath,
  ], { stdio: "pipe" });
  const route = { gatewayPort: 0 };
  const tls = createHttpsServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (incoming, outgoing) => forwardAsServe(incoming, outgoing, route),
  );
  await new Promise<void>((done, fail) => {
    tls.once("error", fail);
    tls.listen(0, "127.0.0.1", () => done());
  });
  const address = tls.address();
  if (address === null || typeof address === "string") {
    tls.close();
    throw new Error("tls bind");
  }
  return {
    port: address.port,
    route,
    close: async () => {
      tls.closeAllConnections();
      await new Promise<void>((done, fail) => {
        tls.close(error => error ? fail(error) : done());
      });
      rmSync(certDir, { recursive: true, force: true });
    },
  };
}

function forwardAsServe(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  route: { gatewayPort: number },
): void {
  if (route.gatewayPort === 0) {
    outgoing.writeHead(503);
    outgoing.end();
    return;
  }
  const headers = {
    ...incoming.headers,
    host: FIXTURE_HOST,
    "tailscale-user-login": FIXTURE_LOGIN,
    "x-forwarded-for": SERVE_CLIENT,
    "x-forwarded-host": FIXTURE_HOST,
    "x-forwarded-proto": "https",
  };
  const upstream = httpRequest({
    hostname: "127.0.0.1", port: route.gatewayPort, path: incoming.url, method: incoming.method, headers,
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

/**
 * The shipped phone path end to end: browser → the Serve emulator → the real
 * `createPhoneGatewayServer` → the dashboard `composeRemoteApproval` builds.
 * `gateway` is the production composition for one test; `origin` is the phone origin.
 */
export const test = base.extend<
  { gateway: ProductionGatewayFixture; origin: string },
  { serveFront: ServeFront }
>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for fixture deps; this fixture needs none.
  serveFront: [async ({}, use) => {
    const front = await startServeFront();
    await use(front);
    await front.close();
  }, { scope: "worker" }],

  launchOptions: [async ({ launchOptions, serveFront }, use) => {
    await use({
      ...launchOptions,
      args: [
        ...launchOptions.args ?? [],
        `--host-resolver-rules=MAP ${FIXTURE_HOST}:443 127.0.0.1:${String(serveFront.port)}`,
      ],
    });
  }, { scope: "worker" }],

  origin: FIXTURE_ORIGIN,

  gateway: async ({ serveFront }, use) => {
    const fixture = await ProductionGatewayFixture.start({
      publicOrigin: FIXTURE_ORIGIN, staticRoot: resolve("dist/dashboard"),
    });
    serveFront.route.gatewayPort = fixture.gateway.address.port;
    await use(fixture);
    serveFront.route.gatewayPort = 0;
    fixture.close();
  },
});

export { expect } from "@playwright/test";
