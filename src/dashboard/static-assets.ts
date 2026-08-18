import { readFileSync, realpathSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, isAbsolute, join, sep } from "node:path";
import { JarvisError } from "../db.js";

export function requestPath(url: string | undefined): string | undefined {
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

export function isAssetRequest(url: string | undefined, normalized: string): boolean {
  return isAssetPrefix(rawPathOnly(url)) || isAssetPrefix(normalized);
}

export function hasFileNameExtension(pathname: string): boolean {
  return pathname.slice(pathname.lastIndexOf("/") + 1).includes(".");
}

export function safeAssetRelative(url: string | undefined, normalized: string): string | undefined {
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

export function writeStaticAsset(input: {
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

export function readStaticIndex(root: string): string {
  const resolvedRoot = realpathSync(root);
  const resolvedIndex = realpathSync(join(resolvedRoot, "index.html"));
  if (dirname(resolvedIndex) !== resolvedRoot) throw new JarvisError("INTERNAL_ERROR");
  return readFileSync(resolvedIndex, "utf8");
}

function rawPathOnly(url: string | undefined): string {
  const source = url ?? "/";
  const cut = source.search(/[?#]/);
  return cut === -1 ? source : source.slice(0, cut);
}

function isAssetPrefix(pathname: string): boolean {
  return pathname === "/assets" || pathname.startsWith("/assets/");
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
