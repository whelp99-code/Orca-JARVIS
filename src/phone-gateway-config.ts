import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { serveForwardedHeadersAllowed } from "./phone-gateway-serve-headers.js";
import {
  LOOPBACK,
  PHONE_GATEWAY_TARGET,
  PHONE_PUBLIC_HTTPS_PORT,
  PHONE_SERVE_HTTPS_FLAG,
  PHONE_ERROR_CODES,
  PhoneGatewayError,
  type PhoneErrorCode,
  type PhoneGatewayConfig,
  type PhoneServeSpec,
  type ServeRequest,
} from "./phone-gateway-protocol.js";

export function parsePhoneGatewayConfig(input: {
  readonly home: string;
  readonly envFile: string;
  readonly uid: number;
}): PhoneGatewayConfig {
  const home = realpathChecked(input.home);
  const configRoot = join(home, ".config", "orca-jarvis");
  const envBytes = readSecretFile(input.envFile, input.uid);
  if (!inside(configRoot, realpathChecked(input.envFile))) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  const records = parseEnvRecords(envBytes.toString("utf8"));
  if (records === undefined) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  const originRaw = records.get("JARVIS_PHONE_PUBLIC_ORIGIN");
  const login = records.get("JARVIS_PHONE_OWNER_LOGIN");
  const keyPath = records.get("JARVIS_PHONE_SESSION_KEY_FILE");
  if (originRaw === undefined || login === undefined || keyPath === undefined || records.size !== 3) {
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  const origin = parseHttpsOrigin(originRaw);
  if (origin === undefined || !isWellFormedLogin(login)) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  if (!isAbsolute(keyPath) || keyPath.includes("\0")) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  const key = readSecretFile(keyPath, input.uid, 32);
  if (!inside(configRoot, realpathChecked(keyPath))) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  return {
    publicOrigin: origin.origin,
    publicHost: origin.host,
    ownerLogin: login,
    sessionKey: key,
    ownerDigest: createHash("sha256").update(login).digest(),
  };
}

export function parsePhoneServeSpec(text: string): PhoneServeSpec {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  const argv = Reflect.get(value, "command_argv");
  if (!Array.isArray(argv) || argv.length !== 5 || argv.some(item => typeof item !== "string")) {
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  const spec = {
    schema_version: Reflect.get(value, "schema_version"),
    exposure: Reflect.get(value, "exposure"),
    protocol: Reflect.get(value, "protocol"),
    port: Reflect.get(value, "port"),
    target: Reflect.get(value, "target"),
    funnel: Reflect.get(value, "funnel"),
    command_argv: argv,
  };
  if (spec.schema_version !== 1 || spec.exposure !== "tailnet-only" || spec.protocol !== "https"
    || spec.port !== PHONE_PUBLIC_HTTPS_PORT || spec.target !== PHONE_GATEWAY_TARGET || spec.funnel !== false
    || spec.command_argv[0] !== "tailscale" || spec.command_argv[1] !== "serve"
    || spec.command_argv[2] !== "--bg" || spec.command_argv[3] !== PHONE_SERVE_HTTPS_FLAG
    || spec.command_argv[4] !== PHONE_GATEWAY_TARGET
    || spec.command_argv.join(" ").toLowerCase().includes("funnel")
    || Object.keys(value).length !== 7) {
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  return {
    schema_version: 1, exposure: "tailnet-only", protocol: "https", port: PHONE_PUBLIC_HTTPS_PORT,
    target: PHONE_GATEWAY_TARGET, funnel: false,
    command_argv: ["tailscale", "serve", "--bg", PHONE_SERVE_HTTPS_FLAG, PHONE_GATEWAY_TARGET],
  };
}

export function isTrustedServeRequest(
  request: ServeRequest,
  expectedHost: string,
): { readonly ok: true; readonly login: string } | { readonly ok: false; readonly code: PhoneErrorCode } {
  if (request.socket.remoteAddress !== LOOPBACK) {
    return { ok: false, code: PHONE_ERROR_CODES.PHONE_PROXY_REQUIRED };
  }
  const hosts = headerValues(request.rawHeaders, "host");
  const logins = headerValues(request.rawHeaders, "tailscale-user-login");
  if (hosts.length !== 1 || hosts[0] !== expectedHost) {
    return { ok: false, code: PHONE_ERROR_CODES.PHONE_HOST_FORBIDDEN };
  }
  if (logins.length !== 1 || logins[0] === undefined || logins[0].length === 0) {
    return { ok: false, code: PHONE_ERROR_CODES.PHONE_IDENTITY_REQUIRED };
  }
  if (!serveForwardedHeadersAllowed(request.rawHeaders, expectedHost)) {
    return { ok: false, code: PHONE_ERROR_CODES.PHONE_FORWARDED_HEADER_FORBIDDEN };
  }
  return { ok: true, login: logins[0] };
}

export function authenticateTailnetOwner(
  login: string,
  expected: string,
): { readonly ok: true } | { readonly ok: false; readonly code: PhoneErrorCode } {
  if (login === expected) return { ok: true };
  if (isWellFormedLogin(login)) return { ok: false, code: PHONE_ERROR_CODES.PHONE_PRINCIPAL_FORBIDDEN };
  return { ok: false, code: PHONE_ERROR_CODES.PHONE_IDENTITY_REQUIRED };
}

export function isWellFormedLogin(login: string): boolean {
  return login.length >= 1 && Buffer.byteLength(login) <= 254 && /^[\x21-\x2b\x2d-\x7e]+$/.test(login);
}

export function headerValues(rawHeaders: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) values.push(rawHeaders[index + 1] ?? "");
  }
  return values;
}

export function inside(root: string, target: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(prefix);
}

export function realpathChecked(path: string): string {
  try { return realpathSync(path); } catch (error) {
    if (error instanceof Error) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
    throw error;
  }
}

export function parseUpstream(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
  if (url.protocol !== "http:" || url.hostname !== LOOPBACK || url.pathname !== "/" || url.search !== ""
    || url.hash !== "" || url.username !== "" || url.password !== "") return undefined;
  const port = url.port === "" ? 80 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return `http://${LOOPBACK}:${String(port)}`;
}

function parseEnvRecords(text: string): Map<string, string> | undefined {
  if (text.includes("\r")) return undefined;
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const records = new Map<string, string>();
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0) return undefined;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || value.length === 0 || records.has(key)) return undefined;
    records.set(key, value);
  }
  return records;
}

function parseHttpsOrigin(value: string): { readonly origin: string; readonly host: string } | undefined {
  let url: URL;
  try { url = new URL(value); } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== ""
    || (url.port !== "" && url.port !== String(PHONE_PUBLIC_HTTPS_PORT))
    || url.search !== "" || url.hash !== "" || (url.pathname !== "/" && url.pathname !== "")) return undefined;
  const host = url.hostname;
  if (host.endsWith(".") || host.includes("*") || host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return undefined;
  }
  const authority = url.host;
  if (value !== `https://${authority}` && value !== `https://${authority}/`) return undefined;
  return { origin: `https://${authority}`, host: authority };
}

function readSecretFile(path: string, uid: number, bytes?: number): Buffer {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  const body = readFileSync(path);
  if (bytes !== undefined && body.byteLength !== bytes) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  return body;
}
