import { createHash } from "node:crypto";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";

const WINDOW_BYTES = 32;
const ROLLING_BASE_A = 257;
const ROLLING_BASE_B = 263;

export type ForbiddenContentIdentity = {
  readonly identity_digest: string;
  readonly content_digest: string;
  readonly content_bytes: number;
  readonly window_bytes: number;
  readonly window_digest: string;
  readonly rolling_hash_a: number;
  readonly rolling_hash_b: number;
};

export function persistForbiddenContentIdentities(
  authority: AuthorityDb,
  input: {
    readonly purge_id: string;
    readonly material: readonly Buffer[];
    readonly observed_at: string;
  },
): readonly ForbiddenContentIdentity[] {
  const identities = deriveForbiddenContentIdentities(input.material);
  const insert = authority.db.prepare(
    `INSERT OR IGNORE INTO memory_forbidden_content_identities(
      purge_id,identity_digest,content_digest,content_bytes,window_bytes,window_digest,
      rolling_hash_a,rolling_hash_b,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?)`,
  );
  for (const identity of identities) insert.run(input.purge_id, identity.identity_digest,
    identity.content_digest, identity.content_bytes, identity.window_bytes,
    identity.window_digest, identity.rolling_hash_a, identity.rolling_hash_b,
    input.observed_at);
  return identities;
}

export function loadForbiddenContentIdentities(authority: AuthorityDb): readonly ForbiddenContentIdentity[] {
  return authority.db.prepare(
    `SELECT identity_digest,content_digest,content_bytes,window_bytes,window_digest,
            rolling_hash_a,rolling_hash_b
     FROM memory_forbidden_content_identities ORDER BY identity_digest`,
  ).all().map(parseIdentity);
}

export function countForbiddenContentMatches(
  value: Buffer,
  identities: readonly ForbiddenContentIdentity[],
): number {
  const matched = new Set<string>();
  const lengths = [...new Set(identities.map(identity => identity.window_bytes))];
  for (const length of lengths) {
    if (value.byteLength < length) continue;
    const candidates = identities.filter(identity => identity.window_bytes === length);
    const byRollingHash = new Map<string, readonly ForbiddenContentIdentity[]>();
    for (const identity of candidates) {
      const key = `${identity.rolling_hash_a}:${identity.rolling_hash_b}`;
      byRollingHash.set(key, [...(byRollingHash.get(key) ?? []), identity]);
    }
    scanWindows(value, { length, candidates: byRollingHash }, matched);
  }
  return matched.size;
}

function deriveForbiddenContentIdentities(
  material: readonly Buffer[],
): readonly ForbiddenContentIdentity[] {
  const identities = new Map<string, ForbiddenContentIdentity>();
  for (const value of material) {
    if (value.byteLength === 0) continue;
    const contentDigest = sha(value);
    const length = Math.min(value.byteLength, WINDOW_BYTES);
    const maximumOffset = value.byteLength - length;
    const selector = createHash("sha256").update(value).digest().readUInt32BE(0);
    const offset = maximumOffset === 0 ? 0 : selector % (maximumOffset + 1);
    const window = value.subarray(offset, offset + length);
    const rolling = rollingHash(window);
    const body = `${contentDigest}\0${String(value.byteLength)}\0${sha(window)}`;
    const identity = { identity_digest: sha(Buffer.from(body)), content_digest: contentDigest,
      content_bytes: value.byteLength, window_bytes: length, window_digest: sha(window),
      rolling_hash_a: rolling.a, rolling_hash_b: rolling.b };
    identities.set(contentDigest, identity);
  }
  return [...identities.values()].sort((left, right) =>
    left.identity_digest.localeCompare(right.identity_digest));
}

function scanWindows(
  value: Buffer,
  window: {
    readonly length: number;
    readonly candidates: ReadonlyMap<string, readonly ForbiddenContentIdentity[]>;
  },
  matched: Set<string>,
): void {
  const powerA = power(ROLLING_BASE_A, window.length - 1);
  const powerB = power(ROLLING_BASE_B, window.length - 1);
  let observed = rollingHash(value.subarray(0, window.length));
  for (let offset = 0; offset <= value.byteLength - window.length; offset += 1) {
    const possible = window.candidates.get(`${observed.a}:${observed.b}`) ?? [];
    if (possible.length > 0) {
      const digest = sha(value.subarray(offset, offset + window.length));
      for (const identity of possible) {
        if (identity.window_digest === digest) matched.add(identity.identity_digest);
      }
    }
    if (offset === value.byteLength - window.length) break;
    const transition = { removed: value[offset] ?? 0,
      added: value[offset + window.length] ?? 0 };
    observed = {
      a: roll(observed.a, transition, { base: ROLLING_BASE_A, leading_power: powerA }),
      b: roll(observed.b, transition, { base: ROLLING_BASE_B, leading_power: powerB }),
    };
  }
}

function rollingHash(value: Buffer): { readonly a: number; readonly b: number } {
  let a = 0;
  let b = 0;
  for (const byte of value) {
    a = (Math.imul(a, ROLLING_BASE_A) + byte) >>> 0;
    b = (Math.imul(b, ROLLING_BASE_B) + byte) >>> 0;
  }
  return { a, b };
}

function roll(
  hash: number,
  transition: { readonly removed: number; readonly added: number },
  parameters: { readonly base: number; readonly leading_power: number },
): number {
  return (Math.imul((hash - Math.imul(transition.removed,
    parameters.leading_power)) >>> 0, parameters.base) + transition.added) >>> 0;
}

function power(base: number, exponent: number): number {
  let value = 1;
  for (let index = 0; index < exponent; index += 1) value = Math.imul(value, base) >>> 0;
  return value;
}

function parseIdentity(value: unknown): ForbiddenContentIdentity {
  if (value === null || typeof value !== "object") throw new JarvisError("MEMORY_FORBIDDEN_IDENTITY_INVALID");
  const identityDigest = Reflect.get(value, "identity_digest");
  const contentDigest = Reflect.get(value, "content_digest");
  const contentBytes = Reflect.get(value, "content_bytes");
  const windowBytes = Reflect.get(value, "window_bytes");
  const windowDigest = Reflect.get(value, "window_digest");
  const hashA = Reflect.get(value, "rolling_hash_a");
  const hashB = Reflect.get(value, "rolling_hash_b");
  if (typeof identityDigest !== "string" || typeof contentDigest !== "string"
    || typeof contentBytes !== "number" || typeof windowBytes !== "number"
    || typeof windowDigest !== "string" || typeof hashA !== "number" || typeof hashB !== "number") {
    throw new JarvisError("MEMORY_FORBIDDEN_IDENTITY_INVALID");
  }
  return { identity_digest: identityDigest, content_digest: contentDigest,
    content_bytes: contentBytes, window_bytes: windowBytes,
    window_digest: windowDigest, rolling_hash_a: hashA, rolling_hash_b: hashB };
}

function sha(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
