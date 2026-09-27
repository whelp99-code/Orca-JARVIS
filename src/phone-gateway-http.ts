import { readFileSync, realpathSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import {
  ERROR_STATUS,
  PHONE_GATEWAY_LIMITS,
  SECURITY,
  type PhoneErrorCode,
} from "./phone-gateway-protocol.js";
import { inside } from "./phone-gateway-config.js";
import { assetName } from "./phone-gateway-routes.js";

export function writePhoneGatewayError(
  response: ServerResponse,
  input: { readonly status?: number; readonly code: PhoneErrorCode; readonly requestId: string },
): void {
  const status = input.status ?? ERROR_STATUS[input.code];
  writeJson(response, status, input.requestId, {
    schema_version: 1,
    error: { code: input.code, message: "Phone gateway request rejected", request_id: input.requestId },
  }, true);
}

export function writeJson(
  response: ServerResponse,
  status: number,
  requestId: string,
  body: unknown,
  extraSecurity: boolean,
): void {
  if (response.headersSent) return;
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Strict-Transport-Security", SECURITY["Strict-Transport-Security"]);
  if (extraSecurity) applySecurity(response);
  response.setHeader("Content-Length", Buffer.byteLength(payload));
  response.end(payload);
}

export function writeHtml(response: ServerResponse, requestId: string, html: string): void {
  if (response.headersSent) return;
  response.statusCode = 200;
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Strict-Transport-Security", SECURITY["Strict-Transport-Security"]);
  applySecurity(response);
  response.setHeader("Content-Length", Buffer.byteLength(html));
  response.end(html);
}

export function phoneHtml(title: string): string {
  return [
    "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"/>",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>",
    "<meta name=\"jarvis-phone-mode\" content=\"1\"/><title>JARVIS</title></head>",
    "<body><a class=\"skip-link\" href=\"#main-content\">skip</a>",
    "<header><nav aria-label=\"Phone\"><a href=\"/\">Today</a>",
    "<a href=\"/memory\">Memory</a><a href=\"/security\">Security</a></nav></header>",
    `<main id="main-content"><h1>${title}</h1></main></body></html>`,
  ].join("");
}

export function retryAfter(response: ServerResponse, seconds: number): void {
  response.setHeader("Retry-After", String(seconds));
}

export function loadAssetNames(root: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const candidate of [join(root, "manifest.json"), join(root, ".vite", "manifest.json")]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof parsed !== "object" || parsed === null) continue;
      for (const value of Object.values(parsed)) {
        if (typeof value !== "object" || value === null) continue;
        const file = Reflect.get(value, "file");
        if (typeof file === "string") names.add(basename(file));
        const css = Reflect.get(value, "css");
        if (!Array.isArray(css)) continue;
        for (const item of css) if (typeof item === "string") names.add(basename(item));
      }
    } catch (error) {
      if (error instanceof Error) continue;
      throw error;
    }
  }
  return names;
}

export function writeAsset(
  response: ServerResponse,
  input: {
    readonly path: string;
    readonly requestId: string;
    readonly staticRoot: string;
    readonly assets: ReadonlySet<string>;
  },
): boolean {
  try {
    if (input.path === "/NOTICE-ARGO.txt") {
      const resolved = realpathSync(join(input.staticRoot, "NOTICE-ARGO.txt"));
      if (dirname(resolved) !== input.staticRoot || !statSync(resolved).isFile()) return false;
      return sendFile(response, input.requestId, resolved, "text/plain; charset=utf-8");
    }
    const name = assetName(input.path);
    if (name === undefined || !input.assets.has(name)) return false;
    const assetsRoot = realpathSync(join(input.staticRoot, "assets"));
    if (!inside(input.staticRoot, assetsRoot)) return false;
    const resolved = realpathSync(join(assetsRoot, name));
    if (!inside(assetsRoot, resolved) || !statSync(resolved).isFile()) return false;
    const type = name.endsWith(".css") ? "text/css; charset=utf-8"
      : name.endsWith(".js") ? "text/javascript; charset=utf-8" : undefined;
    if (type === undefined) return false;
    return sendFile(response, input.requestId, resolved, type);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

function applySecurity(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", SECURITY["Content-Security-Policy"]);
  response.setHeader("Referrer-Policy", SECURITY["Referrer-Policy"]);
  response.setHeader("X-Content-Type-Options", SECURITY["X-Content-Type-Options"]);
  response.setHeader("X-Frame-Options", SECURITY["X-Frame-Options"]);
  response.setHeader("Permissions-Policy", SECURITY["Permissions-Policy"]);
}

function sendFile(response: ServerResponse, requestId: string, file: string, type: string): boolean {
  const body = readFileSync(file);
  if (body.byteLength > PHONE_GATEWAY_LIMITS.asset) return false;
  if (response.headersSent) return true;
  response.statusCode = 200;
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("Content-Type", type);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Strict-Transport-Security", SECURITY["Strict-Transport-Security"]);
  applySecurity(response);
  response.setHeader("Content-Length", body.byteLength);
  response.end(body);
  return true;
}
