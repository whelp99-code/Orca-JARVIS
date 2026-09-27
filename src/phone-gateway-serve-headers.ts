import { BlockList, isIPv4, isIPv6 } from "node:net";
import { FORBIDDEN_HEADERS } from "./phone-gateway-protocol.js";

const TAILSCALE_CLIENTS = new BlockList();
TAILSCALE_CLIENTS.addSubnet("100.64.0.0", 10, "ipv4");
TAILSCALE_CLIENTS.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

const SERVE_FORWARDED_HEADERS = new Set([
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

/**
 * Tailscale Serve always injects X-Forwarded-For/Host/Proto. Accept that exact
 * trio from the loopback peer, and keep rejecting every other proxy header.
 * Absence is the direct loopback client, which stays allowed.
 */
export function serveForwardedHeadersAllowed(
  rawHeaders: readonly string[],
  expectedHost: string,
): boolean {
  const forwardedFor: string[] = [];
  const forwardedHost: string[] = [];
  const forwardedProto: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]?.toLowerCase();
    if (name === undefined) continue;
    const value = rawHeaders[index + 1] ?? "";
    if (FORBIDDEN_HEADERS.has(name) || (name.startsWith("x-forwarded-") && !SERVE_FORWARDED_HEADERS.has(name))) {
      return false;
    }
    if (name === "x-forwarded-for") forwardedFor.push(value);
    if (name === "x-forwarded-host") forwardedHost.push(value);
    if (name === "x-forwarded-proto") forwardedProto.push(value);
  }
  const present = forwardedFor.length + forwardedHost.length + forwardedProto.length;
  if (present === 0) return true;
  const client = forwardedFor[0];
  const host = forwardedHost[0];
  const proto = forwardedProto[0];
  return forwardedFor.length === 1 && forwardedHost.length === 1 && forwardedProto.length === 1
    && client !== undefined && host === expectedHost && proto === "https"
    && isTailscaleClient(client);
}

function isTailscaleClient(value: string): boolean {
  if (isIPv4(value)) return TAILSCALE_CLIENTS.check(value, "ipv4");
  if (!isIPv6(value) || value.includes(".")) return false;
  return TAILSCALE_CLIENTS.check(value, "ipv6");
}
