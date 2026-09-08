import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const PHONE_COOKIE_NAME = "__Host-jarvis-phone" as const;
export const PHONE_IDLE_MS = 15 * 60 * 1000;
export const PHONE_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
export const PHONE_SESSION_CAP = 128;
export const PHONE_COOKIE_MAX_BYTES = 4096;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type PhoneIssueResult =
  | {
    readonly kind: "issued";
    readonly cookieId: string;
    readonly csrfToken: string;
    readonly setCookie: string;
    readonly expiresAt: number;
  }
  | { readonly kind: "capacity" };

export type PhoneAuthResult =
  | { readonly kind: "ok"; readonly idHmac: Buffer; readonly csrfHmac: Buffer; readonly expiresAt: number }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" };

export type PhoneGatewaySessionStore = {
  issue(ownerDigest: Buffer): PhoneIssueResult;
  authenticate(cookieHeader: string | undefined, ownerDigest: Buffer): PhoneAuthResult;
  csrfMatches(csrfHmac: Buffer, candidate: string): boolean;
  touch(idHmac: Buffer): { readonly maxAge: number } | undefined;
  expireCookie(): string;
  inspectDigests(): readonly string[];
};

type SessionRecord = {
  readonly idHmac: Buffer;
  readonly csrfHmac: Buffer;
  readonly ownerDigest: Buffer;
  readonly issuedAt: number;
  lastSeenAt: number;
  readonly absoluteExpiry: number;
};

export function createPhoneGatewaySessionStore(input: {
  readonly key: Buffer;
  readonly now: () => number;
}): PhoneGatewaySessionStore {
  const records = new Map<string, SessionRecord>();
  const hmac = (value: string): Buffer => createHmac("sha256", input.key).update(value).digest();
  const digestKey = (idHmac: Buffer): string => idHmac.toString("hex");
  const gc = (): void => {
    const now = input.now();
    for (const [key, record] of records) {
      if (expired(record, now)) records.delete(key);
    }
  };
  return {
    issue(ownerDigest: Buffer): PhoneIssueResult {
      gc();
      if (records.size >= PHONE_SESSION_CAP) return { kind: "capacity" };
      const cookieId = randomBytes(TOKEN_BYTES).toString("base64url");
      const csrfToken = randomBytes(TOKEN_BYTES).toString("base64url");
      const now = input.now();
      const idHmac = hmac(cookieId);
      records.set(digestKey(idHmac), {
        idHmac,
        csrfHmac: hmac(csrfToken),
        ownerDigest: Buffer.from(ownerDigest),
        issuedAt: now,
        lastSeenAt: now,
        absoluteExpiry: now + PHONE_ABSOLUTE_MS,
      });
      const maxAge = cookieMaxAge(now, now + PHONE_ABSOLUTE_MS);
      return {
        kind: "issued",
        cookieId,
        csrfToken,
        setCookie: serializeCookie(cookieId, maxAge),
        expiresAt: now + PHONE_IDLE_MS,
      };
    },
    authenticate(cookieHeader: string | undefined, ownerDigest: Buffer): PhoneAuthResult {
      if (cookieHeader === undefined || cookieHeader.length === 0) return { kind: "missing" };
      if (Buffer.byteLength(cookieHeader) > PHONE_COOKIE_MAX_BYTES) return { kind: "invalid" };
      const parsed = parseCookieId(cookieHeader);
      if (parsed.kind === "missing") return { kind: "missing" };
      if (parsed.kind === "invalid") return { kind: "invalid" };
      gc();
      const idHmac = hmac(parsed.cookieId);
      const record = records.get(digestKey(idHmac));
      if (record === undefined || expired(record, input.now())) return { kind: "invalid" };
      if (!sameBuffer(record.ownerDigest, ownerDigest)) return { kind: "invalid" };
      return { kind: "ok", idHmac: Buffer.from(record.idHmac), csrfHmac: Buffer.from(record.csrfHmac),
        expiresAt: Math.min(record.absoluteExpiry, record.lastSeenAt + PHONE_IDLE_MS) };
    },
    csrfMatches(csrfHmac: Buffer, candidate: string): boolean {
      const actual = hmac(candidate);
      return actual.length === csrfHmac.length && timingSafeEqual(actual, csrfHmac);
    },
    touch(idHmac: Buffer): { readonly maxAge: number } | undefined {
      const record = records.get(digestKey(idHmac));
      const now = input.now();
      if (record === undefined || expired(record, now)) return undefined;
      record.lastSeenAt = now;
      return { maxAge: cookieMaxAge(now, record.absoluteExpiry) };
    },
    expireCookie(): string {
      return `${PHONE_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
    },
    inspectDigests(): readonly string[] {
      return [...records.values()].map(record => record.idHmac.toString("hex"));
    },
  };
}

function expired(record: SessionRecord, now: number): boolean {
  return now - record.lastSeenAt > PHONE_IDLE_MS || now >= record.absoluteExpiry;
}

function cookieMaxAge(now: number, absoluteExpiry: number): number {
  const remaining = Math.max(0, Math.floor((absoluteExpiry - now) / 1000));
  return Math.min(900, remaining);
}

export function serializeCookie(cookieId: string, maxAge: number): string {
  return `${PHONE_COOKIE_NAME}=${cookieId}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${String(maxAge)}`;
}

function parseCookieId(header: string):
  | { readonly kind: "ok"; readonly cookieId: string }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" } {
  let found: string | undefined;
  let sawName = false;
  for (const part of header.split(";")) {
    const cut = part.indexOf("=");
    if (cut <= 0) continue;
    const name = part.slice(0, cut).trim();
    const value = part.slice(cut + 1).trim();
    if (name !== PHONE_COOKIE_NAME) continue;
    sawName = true;
    if (found !== undefined) return { kind: "invalid" };
    found = value;
  }
  if (!sawName || found === undefined) return { kind: "missing" };
  if (!TOKEN_PATTERN.test(found)) return { kind: "invalid" };
  return { kind: "ok", cookieId: found };
}

function sameBuffer(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
