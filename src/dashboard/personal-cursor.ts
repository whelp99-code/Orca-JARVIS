import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalize } from "../canonical.js";
import type { PersonalListResource } from "./personal-contracts.js";

const CURSOR_VERSION = 1 as const;
const CURSOR_TTL_MS = 5 * 60_000;
const CURSOR_MAX_BYTES = 2_048;
const DIGEST = /^[0-9a-f]{64}$/;

type CursorPayload = {
  readonly v: 1;
  readonly resource: PersonalListResource;
  readonly limit: number;
  readonly total: number;
  readonly anchor: readonly [string, string];
  readonly issued_at: string;
};

export class PersonalCursorError extends Error {
  readonly name = "PersonalCursorError";
  constructor() { super("PERSONAL_CURSOR_INVALID"); }
}

export class PersonalCursorCodec {
  constructor(private readonly key: Buffer) {
    if (key.byteLength < 32) throw new PersonalCursorError();
  }

  encode(payload: Omit<CursorPayload, "v">): string {
    const bytes = Buffer.from(canonicalize({ v: CURSOR_VERSION, ...payload }), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.key).update(bytes).digest("hex");
    return `${bytes}.${signature}`;
  }

  decode(value: string, expected: PersonalListResource, limit: number, now: Date): CursorPayload {
    if (Buffer.byteLength(value, "utf8") > CURSOR_MAX_BYTES) throw new PersonalCursorError();
    const parts = value.split(".");
    const bytes = parts[0];
    const signature = parts[1];
    if (parts.length !== 2 || bytes === undefined || signature === undefined || !DIGEST.test(signature)) {
      throw new PersonalCursorError();
    }
    const expectedSignature = createHmac("sha256", this.key).update(bytes).digest();
    const actualSignature = Buffer.from(signature, "hex");
    if (actualSignature.byteLength !== expectedSignature.byteLength || !timingSafeEqual(actualSignature, expectedSignature)) {
      throw new PersonalCursorError();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes, "base64url").toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new PersonalCursorError();
      throw error;
    }
    const payload = parsePayload(parsed);
    const issued = Date.parse(payload.issued_at);
    if (payload.resource !== expected || payload.limit !== limit || !Number.isFinite(issued)
      || now.getTime() < issued || now.getTime() - issued > CURSOR_TTL_MS) throw new PersonalCursorError();
    return payload;
  }
}

function parsePayload(value: unknown): CursorPayload {
  if (!plainRecord(value)) throw new PersonalCursorError();
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "anchor,issued_at,limit,resource,total,v") throw new PersonalCursorError();
  const resource = personalResource(value["resource"]);
  const limit = value["limit"];
  const total = value["total"];
  const issuedAt = value["issued_at"];
  const anchor = value["anchor"];
  if (value["v"] !== CURSOR_VERSION || resource === undefined
    || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1
    || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0
    || typeof issuedAt !== "string" || !Array.isArray(anchor)
    || anchor.length !== 2 || anchor.some((item) => typeof item !== "string")) {
    throw new PersonalCursorError();
  }
  const first = anchor[0];
  const second = anchor[1];
  if (typeof first !== "string" || typeof second !== "string") throw new PersonalCursorError();
  return { v: CURSOR_VERSION, resource, limit, total, anchor: [first, second], issued_at: issuedAt };
}

function personalResource(value: unknown): PersonalListResource | undefined {
  const resources: readonly PersonalListResource[] = ["daily-runs", "decision-inbox", "notification-intents", "source-health"];
  return typeof value === "string" ? resources.find((item) => item === value) : undefined;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
