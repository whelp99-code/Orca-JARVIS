import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { HandsError } from "./errors.js";

export const OMONYANG_AGENT = "agent:omonyang";

export type AgentTokenFile = {
  readonly agent: typeof OMONYANG_AGENT;
  readonly token: string;
};

/** Loopback or Tailscale CGNAT (100.64.0.0/10). No Linux-only socket names. */
export function bindAllowed(bind: string): boolean {
  if (bind === "stdio" || bind === "localhost" || bind === "127.0.0.1" || bind === "::1") return true;
  const match = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(bind);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 64 && second <= 127;
}

export function assertBind(bind: string): void {
  if (!bindAllowed(bind)) throw new HandsError("BIND_FORBIDDEN", bind);
}

export function loadAgentToken(path: string): AgentTokenFile {
  const stat = statSync(path);
  if (!stat.isFile()) throw new HandsError("AUTH_REQUIRED", "not a file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new HandsError("AUTH_TOKEN_MODE", path);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new HandsError("AUTH_IDENTITY", "owner");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new HandsError("AUTH_REQUIRED", "json"); }
  if (typeof parsed !== "object" || parsed === null) throw new HandsError("AUTH_REQUIRED", "shape");
  const agent = (parsed as { agent?: unknown }).agent;
  const token = (parsed as { token?: unknown }).token;
  if (agent !== OMONYANG_AGENT) throw new HandsError("AUTH_IDENTITY", String(agent));
  if (typeof token !== "string" || token.length < 32) throw new HandsError("AUTH_REQUIRED", "token");
  return { agent: OMONYANG_AGENT, token };
}

export function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
