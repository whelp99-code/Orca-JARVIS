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

export const PHONE_MODE_META = "<meta name=\"jarvis-phone-mode\" content=\"1\"/>";

/**
 * The built dashboard document, marked for phone mode. Undefined (the shell answers
 * 503) when the release has no document or it references an asset the manifest
 * does not list, because the gateway would refuse that asset anyway.
 */
export function loadPhoneDocument(root: string, assets: ReadonlySet<string>): string | undefined {
  let html: string;
  try {
    html = readFileSync(join(root, "index.html"), "utf8");
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
  if (Buffer.byteLength(html) > PHONE_GATEWAY_LIMITS.html || !html.includes("<head>")) return undefined;
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*\s(?:src|href)="([^"]*)"/g)) {
    const reference = match[1] ?? "";
    if (reference.startsWith("data:")) continue;
    const name = assetName(reference);
    if (name === undefined || !assets.has(name)) return undefined;
  }
  return html.replace("<head>", `<head>${PHONE_MODE_META}`);
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
