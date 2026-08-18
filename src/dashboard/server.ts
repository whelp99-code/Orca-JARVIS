import { readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BoundSocket } from "node:net";
import { dirname, isAbsolute, join, sep } from "node:path";

declare module "node:net" {
  export class BoundSocket {
    constructor(options?: { readonly host?: string; readonly port?: number });
    address(): { address: string; family: string; port: number };
    close(): void;
  }
}
import { JarvisError, type AuthorityDb } from "../db.js";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";
import {
  createRequestId,
  DASHBOARD_ERROR_CODES,
  isLoopbackHostHeader,
  writeDashboardError,
  writeDashboardHtml,
  writeDashboardJson,
} from "./http.js";
import { DashboardReadModel } from "./read-model.js";

const LOOPBACK_HOST = "127.0.0.1";

export type DashboardAddress = {
  readonly host: string;
  readonly port: number;
  readonly family: string;
};

export type DashboardServer = {
  readonly address: DashboardAddress;
  close(): void;
};

export type DashboardServerOptions = {
  readonly db: AuthorityDb;
  readonly staticRoot: string;
  readonly host: string;
  readonly port: number;
};

export function createDashboardServer(options: DashboardServerOptions): DashboardServer & {
  readonly address: { readonly host: string; readonly port: number; readonly family: "IPv4" };
} {
  if (options.host !== LOOPBACK_HOST) throw new JarvisError("LOCAL_SESSION_REQUIRED");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new JarvisError("VALIDATION_ERROR");
  }
  realpathSync(options.staticRoot);
  const model = new DashboardReadModel(options.db);
  const bound = new BoundSocket({ host: LOOPBACK_HOST, port: options.port });
  const httpServer = createServer((request, response) => {
    void handleRequest({ db: options.db, model, staticRoot: options.staticRoot, request, response });
  });
  httpServer.listen(bound);
  const boundAddress = httpServer.address();
  if (boundAddress === null || typeof boundAddress === "string") {
    httpServer.close();
    throw new JarvisError("LOCAL_SESSION_REQUIRED");
  }
  if (boundAddress.family !== "IPv4" || boundAddress.address !== LOOPBACK_HOST) {
    httpServer.closeAllConnections();
    httpServer.close();
    throw new JarvisError("LOCAL_SESSION_REQUIRED");
  }
  return {
    address: { host: LOOPBACK_HOST, port: boundAddress.port, family: "IPv4" },
    close(): void {
      httpServer.closeAllConnections();
      httpServer.close();
    },
  };
}

async function handleRequest(input: {
  readonly db: AuthorityDb;
  readonly model: DashboardReadModel;
  readonly staticRoot: string;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
}): Promise<void> {
  const requestId = createRequestId(input.request);
  try {
    if (!isLoopbackHostHeader(input.request.headers.host)) {
      writeDashboardError(input.response, {
        status: 403,
        code: DASHBOARD_ERROR_CODES.LOCAL_SESSION_REQUIRED,
        requestId,
      });
      return;
    }
    const path = requestPath(input.request.url);
    if (path === undefined || input.request.method !== "GET") {
      writeDashboardError(input.response, { status: 404, code: DASHBOARD_ERROR_CODES.NOT_FOUND, requestId });
      return;
    }
    if (path === "/api/v1/health") {
      await writeHealth(input.db, input.response, requestId);
      return;
    }
    if (path === "/api/v1/overview") {
      writeDashboardJson(input.response, { status: 200, body: await input.model.overview(), requestId });
      return;
    }
    if (path === "/api" || path.startsWith("/api/")) {
      writeDashboardError(input.response, { status: 404, code: DASHBOARD_ERROR_CODES.NOT_FOUND, requestId });
      return;
    }
    if (isAssetRequest(input.request.url, path) || hasFileNameExtension(path)) {
      const relativePath = safeAssetRelative(input.request.url, path);
      if (relativePath === undefined || !writeStaticAsset({ response: input.response, staticRoot: input.staticRoot, relativePath, requestId })) {
        writeDashboardError(input.response, { status: 404, code: DASHBOARD_ERROR_CODES.NOT_FOUND, requestId });
      }
      return;
    }
    writeDashboardHtml(input.response, { status: 200, body: readStaticIndex(input.staticRoot), requestId });
  } catch (error) {
    if (input.response.headersSent) {
      input.response.destroy();
      return;
    }
    if (error instanceof JarvisError && error.code === "AUTHORITY_NOT_READY") {
      writeDashboardError(input.response, {
        status: 503,
        code: DASHBOARD_ERROR_CODES.AUTHORITY_NOT_READY,
        requestId,
      });
      return;
    }
    writeDashboardError(input.response, { status: 500, code: DASHBOARD_ERROR_CODES.INTERNAL_ERROR, requestId });
  }
}

async function writeHealth(db: AuthorityDb, response: ServerResponse, requestId: string): Promise<void> {
  try {
    await db.assertMigrationsReady();
  } catch (error) {
    if (error instanceof Error) {
      writeDashboardError(response, { status: 503, code: DASHBOARD_ERROR_CODES.AUTHORITY_NOT_READY, requestId });
      return;
    }
    throw error;
  }
  writeDashboardJson(response, {
    status: 200,
    body: { schema_version: DASHBOARD_SCHEMA_VERSION, status: "ok", authority: "ready", generated_at: new Date().toISOString() },
    requestId,
  });
}

function requestPath(url: string | undefined): string | undefined {
  try {
    const pathname = decodeURIComponent(new URL(url ?? "/", "http://127.0.0.1").pathname);
    if (pathname.includes("\0") || pathname.includes("\\")) return undefined;
    const parts: string[] = [];
    for (const part of pathname.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") return undefined;
      parts.push(part);
    }
    return `/${parts.join("/")}`;
  } catch (error) {
    if (error instanceof URIError || error instanceof TypeError) return undefined;
    throw error;
  }
}

function rawPathOnly(url: string | undefined): string {
  const source = url ?? "/";
  const cut = source.search(/[?#]/);
  return cut === -1 ? source : source.slice(0, cut);
}

function isAssetPrefix(pathname: string): boolean {
  return pathname === "/assets" || pathname.startsWith("/assets/");
}

function isAssetRequest(url: string | undefined, normalized: string): boolean {
  return isAssetPrefix(rawPathOnly(url)) || isAssetPrefix(normalized);
}

function hasFileNameExtension(pathname: string): boolean {
  return pathname.slice(pathname.lastIndexOf("/") + 1).includes(".");
}

function safeAssetRelative(url: string | undefined, normalized: string): string | undefined {
  try {
    const decoded = decodeURIComponent(rawPathOnly(url));
    if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes("..")) {
      return undefined;
    }
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
  if (!isAssetPrefix(normalized) || normalized === "/assets") return undefined;
  const relativePath = normalized.slice("/assets/".length);
  if (relativePath.length === 0 || isAbsolute(relativePath) || relativePath.includes("\0") || relativePath.includes("\\")) {
    return undefined;
  }
  for (const part of relativePath.split("/")) {
    if (part === "" || part === "." || part === "..") return undefined;
  }
  return relativePath;
}

function assetContentType(relativePath: string): string | undefined {
  const slash = relativePath.lastIndexOf("/");
  const name = (slash === -1 ? relativePath : relativePath.slice(slash + 1)).toLowerCase();
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
  return undefined;
}

function isInsideDirectory(root: string, target: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

function writeStaticAsset(input: {
  readonly response: ServerResponse;
  readonly staticRoot: string;
  readonly relativePath: string;
  readonly requestId: string;
}): boolean {
  const contentType = assetContentType(input.relativePath);
  if (contentType === undefined) return false;
  try {
    const resolvedRoot = realpathSync(input.staticRoot);
    const assetsRoot = realpathSync(join(resolvedRoot, "assets"));
    if (!isInsideDirectory(resolvedRoot, assetsRoot)) return false;
    const resolvedFile = realpathSync(join(assetsRoot, input.relativePath));
    if (!isInsideDirectory(assetsRoot, resolvedFile)) return false;
    if (!statSync(resolvedFile).isFile()) return false;
    const body = readFileSync(resolvedFile);
    if (input.response.headersSent) return true;
    input.response.statusCode = 200;
    input.response.setHeader("X-Request-Id", input.requestId);
    input.response.setHeader("Content-Type", contentType);
    input.response.setHeader("Cache-Control", "no-store");
    input.response.setHeader("Content-Length", body.byteLength);
    input.response.end(body);
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

function readStaticIndex(root: string): string {
  const resolvedRoot = realpathSync(root);
  const resolvedIndex = realpathSync(join(resolvedRoot, "index.html"));
  if (dirname(resolvedIndex) !== resolvedRoot) throw new JarvisError("INTERNAL_ERROR");
  return readFileSync(resolvedIndex, "utf8");
}
