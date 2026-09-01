import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync } from "node:fs";

export function processUid(): number {
  const getuid = process.getuid;
  if (getuid === undefined) throw new Error("uid required");
  return getuid();
}

export const FIXTURE_ORIGIN = "https://jarvis-fixture.example.invalid" as const;
export const FIXTURE_HOST = "jarvis-fixture.example.invalid" as const;
export const FIXTURE_LOGIN = "owner@example.invalid" as const;
export const FIXTURE_CSRF_HEADER = "x-jarvis-csrf" as const;

export type PhoneEnvFiles = {
  readonly home: string;
  readonly envFile: string;
  readonly keyFile: string;
  readonly key: Buffer;
};

export function makePhoneHome(root = mkdtempSync(join(tmpdir(), "jarvis-phone-"))): PhoneEnvFiles {
  const configDir = join(root, ".config", "orca-jarvis");
  mkdirSync(configDir, { recursive: true });
  const key = Buffer.alloc(32, 7);
  const keyFile = join(configDir, "phone-session.key");
  writeFileSync(keyFile, key);
  chmodSync(keyFile, 0o600);
  const envFile = join(configDir, "phone-gateway.env");
  writeFileSync(envFile, [
    `JARVIS_PHONE_PUBLIC_ORIGIN=${FIXTURE_ORIGIN}`,
    `JARVIS_PHONE_OWNER_LOGIN=${FIXTURE_LOGIN}`,
    `JARVIS_PHONE_SESSION_KEY_FILE=${keyFile}`,
    "",
  ].join("\n"));
  chmodSync(envFile, 0o600);
  return { home: root, envFile, keyFile, key };
}

export type CapturedUpstream = {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly rawHeaders: readonly string[];
  readonly body: Buffer;
};

export type FakeAuthority = {
  port: number;
  origin: string;
  readonly captures: CapturedUpstream[];
  csrf: string;
  healthState: string;
  close(): Promise<void>;
};

export async function startFakeAuthority(handler?: (
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer,
) => boolean): Promise<FakeAuthority> {
  const captures: CapturedUpstream[] = [];
  const state: FakeAuthority = {
    port: 0,
    origin: "",
    captures,
    csrf: "authority-csrf-token-aaaaaaaaaaaaaaaaaaaaaa",
    healthState: "ready",
    close: async () => undefined,
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      captures.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        rawHeaders: [...request.rawHeaders],
        body,
      });
      if (handler?.(request, response, body) === true) return;
      defaultAuthority(state, request, response, body);
    });
  });
  await listenLoopback(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("authority bind required");
  state.port = address.port;
  state.origin = `http://127.0.0.1:${String(address.port)}`;
  state.close = () => closeServer(server);
  return state;
}

function defaultAuthority(
  state: FakeAuthority,
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer,
): void {
  const url = request.url ?? "";
  const path = url.split("?")[0] ?? "";
  if (request.method === "GET" && path === "/api/v1/session") {
    json(response, 200, { schema_version: 1, csrf_token: state.csrf });
    return;
  }
  if (request.method === "GET" && path === "/api/v1/health") {
    json(response, 200, { schema_version: 1, status: "ok", authority: state.healthState });
    return;
  }
  const csrf = header(request, "x-jarvis-csrf");
  if (csrf !== state.csrf) {
    json(response, 403, { schema_version: 1, error: { code: "LOCAL_SESSION_REQUIRED", message: "Local session required" } });
    return;
  }
  if (request.method === "GET" && path === "/api/v1/today") {
    json(response, 200, { schema_version: 1, resource: "today", state: "ready" });
    return;
  }
  if (request.method === "GET" && path === "/api/v1/memory/status") {
    json(response, 200, { schema_version: 1, state: "ready", contract_schema: 4 });
    return;
  }
  if (request.method === "GET" && path === "/api/v1/memory/conflicts") {
    json(response, 200, { schema_version: 1, items: [] });
    return;
  }
  if (request.method === "POST" && path === "/api/v1/memory/search") {
    json(response, 200, { schema_version: 1, items: [], echoed: body.toString("utf8") });
    return;
  }
  if (request.method === "POST" && path === "/api/v1/memory/records/detail") {
    json(response, 200, { schema_version: 1, record: { token_present: true } });
    return;
  }
  if (request.method === "GET" && path.startsWith("/api/v1/decision-inbox")) {
    json(response, 200, { schema_version: 1, resource: "decision-inbox", items: [] });
    return;
  }
  if (request.method === "GET" && path.startsWith("/api/v1/notification-intents")) {
    json(response, 200, { schema_version: 1, resource: "notification-intents", items: [] });
    return;
  }
  if (request.method === "GET" && path.startsWith("/api/v1/source-health")) {
    json(response, 200, { schema_version: 1, resource: "source-health", items: [] });
    return;
  }
  if (request.method === "GET" && path.startsWith("/api/v1/recommendations/")) {
    json(response, 200, { schema_version: 1, resource: "recommendation", recommendation_id: "rec-1" });
    return;
  }
  if (request.method === "GET" && path.includes("/evidence")) {
    json(response, 200, { schema_version: 1, resource: "context-evidence" });
    return;
  }
  json(response, 404, { schema_version: 1, error: { code: "NOT_FOUND", message: "Not found" } });
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

export function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

export function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  });
}

export type RawHttpResult = {
  readonly status: number;
  readonly raw: string;
  readonly headers: string;
  readonly body: string;
};

export function rawHttp(port: number, request: string): Promise<RawHttpResult> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let data = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", chunk => { data += chunk; });
    socket.on("end", () => {
      const split = data.indexOf("\r\n\r\n");
      const headers = split === -1 ? data : data.slice(0, split);
      const body = split === -1 ? "" : data.slice(split + 4);
      const status = Number(/HTTP\/1\.\d (\d{3})/.exec(headers)?.[1] ?? 0);
      resolve({ status, raw: data, headers, body });
    });
    socket.on("connect", () => socket.end(request));
  });
}

export function identityHeaders(extra: readonly string[] = []): readonly string[] {
  return [
    "Host", FIXTURE_HOST,
    "Tailscale-User-Login", FIXTURE_LOGIN,
    ...extra,
  ];
}

export function cookieFromSetCookie(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  const match = /^__Host-jarvis-phone=([^;]+)/.exec(value);
  return match?.[1];
}
