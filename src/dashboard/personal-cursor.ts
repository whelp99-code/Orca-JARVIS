import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { PersonalListResource } from "./personal-contracts.js";

const CURSOR_VERSION = 1 as const;
const CURSOR_TTL_MS = 5 * 60_000;
const CURSOR_MAX_BYTES = 2_048;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from("orca-jarvis/personal-cursor/v1", "utf8");
const DIGEST = /^sha256:[0-9a-f]{64}$/;

type CursorKey = readonly [string, string];
export type CursorPayload = {
  readonly resource: PersonalListResource;
  readonly limit: number;
  readonly filter: string;
  readonly order: string;
  readonly expires_at: string;
  readonly snapshot: {
    readonly id: string;
    readonly upper: CursorKey;
    readonly revision: string;
    readonly total: number;
  };
  readonly anchor: { readonly key: CursorKey; readonly digest: string; readonly index: number };
};
export type PersonalCursorCodecOptions = {
  readonly key: Buffer;
  readonly sessionId: string;
  readonly keyEpoch: number;
};
export class PersonalCursorError extends Error {
  readonly name: string = "PersonalCursorError";
  constructor(message = "PERSONAL_CURSOR_INVALID") { super(message); }
}
export class PersonalCursorStaleError extends PersonalCursorError {
  readonly name = "PersonalCursorStaleError";
  constructor() { super("PERSONAL_CURSOR_STALE"); }
}

export class PersonalCursorCodec {
  private readonly key: Buffer;
  private readonly sessionId: string;
  private readonly keyEpoch: number;

  constructor(options: PersonalCursorCodecOptions) {
    if (options.key.byteLength !== 32 || options.sessionId.length === 0
      || !Number.isSafeInteger(options.keyEpoch) || options.keyEpoch < 1) throw new PersonalCursorError();
    this.key = Buffer.from(options.key);
    this.sessionId = options.sessionId;
    this.keyEpoch = options.keyEpoch;
  }

  encode(payload: CursorPayload): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const plaintext = Buffer.from(JSON.stringify({
      v: CURSOR_VERSION, session: this.sessionId, epoch: this.keyEpoch, ...payload,
    }), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  decode(value: string, expected: {
    readonly resource: PersonalListResource;
    readonly limit: number;
    readonly filter: string;
    readonly order: string;
    readonly now: Date;
  }): CursorPayload {
    if (value.length === 0 || Buffer.byteLength(value, "utf8") > CURSOR_MAX_BYTES) throw new PersonalCursorError();
    let parsed: unknown;
    try {
      const sealed = Buffer.from(value, "base64url");
      if (sealed.byteLength <= IV_BYTES + TAG_BYTES) throw new PersonalCursorError();
      const decipher = createDecipheriv("aes-256-gcm", this.key, sealed.subarray(0, IV_BYTES));
      decipher.setAAD(AAD);
      decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const plaintext = Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
      parsed = JSON.parse(plaintext.toString("utf8"));
    } catch (error) {
      if (error instanceof Error) throw new PersonalCursorError();
      throw error;
    }
    const payload = parsePayload(parsed, this.sessionId, this.keyEpoch);
    if (payload.resource !== expected.resource || payload.limit !== expected.limit
      || payload.filter !== expected.filter || payload.order !== expected.order
      || expected.now.toISOString() >= payload.expires_at) throw new PersonalCursorError();
    return payload;
  }
}

export function personalCursorExpiry(now: Date): string {
  return new Date(now.getTime() + CURSOR_TTL_MS).toISOString();
}

function parsePayload(value: unknown, sessionId: string, keyEpoch: number): CursorPayload {
  const row = exactRecord(value, ["v", "session", "epoch", "resource", "limit", "filter", "order", "expires_at", "snapshot", "anchor"]);
  const snapshot = exactRecord(row["snapshot"], ["id", "upper", "revision", "total"]);
  const anchor = exactRecord(row["anchor"], ["key", "digest", "index"]);
  const resource = personalResource(row["resource"]);
  if (row["v"] !== CURSOR_VERSION || row["session"] !== sessionId || row["epoch"] !== keyEpoch || resource === undefined
    || !positiveInteger(row["limit"]) || typeof row["filter"] !== "string" || typeof row["order"] !== "string"
    || !validInstant(row["expires_at"]) || typeof snapshot["id"] !== "string" || !tuple(snapshot["upper"])
    || typeof snapshot["revision"] !== "string" || !DIGEST.test(snapshot["revision"]) || !nonnegativeInteger(snapshot["total"])
    || !tuple(anchor["key"]) || typeof anchor["digest"] !== "string" || !DIGEST.test(anchor["digest"])
    || !nonnegativeInteger(anchor["index"])) throw new PersonalCursorError();
  return { resource, limit: row["limit"], filter: row["filter"], order: row["order"], expires_at: row["expires_at"],
    snapshot: { id: snapshot["id"], upper: snapshot["upper"], revision: snapshot["revision"], total: snapshot["total"] },
    anchor: { key: anchor["key"], digest: anchor["digest"], index: anchor["index"] } };
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new PersonalCursorError();
  }
  const record = Object.fromEntries(Object.entries(value));
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new PersonalCursorError();
  return record;
}
function tuple(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string";
}
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function nonnegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}
function personalResource(value: unknown): PersonalListResource | undefined {
  const resources: readonly PersonalListResource[] = ["daily-runs", "decision-inbox", "notification-intents", "source-health"];
  return typeof value === "string" ? resources.find((item) => item === value) : undefined;
}
