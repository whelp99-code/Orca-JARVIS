import { createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { canonicalize } from "../canonical.js";
import { JarvisError } from "../db.js";
import {
  PORTFOLIO_AUTH_ENVELOPE_KEYS,
  PORTFOLIO_MAX_BYTES,
  PORTFOLIO_PRODUCERS,
  type PortfolioAuthEnvelopeV1,
  type PortfolioAuthPayload,
  type PortfolioEnvironment,
  type PortfolioProducer,
  type PortfolioVerifiedPayload,
} from "./portfolio-contracts.js";
import { parsePortfolioIngest } from "./portfolio-parse.js";

const HMAC_KEY_MIN_BYTES = 32;
const HMAC_KEY_MAX_BYTES = 64;
const HMAC_HEX_PATTERN = /^hmac-sha256:([0-9a-f]{64})$/;
const FILE_MODE_MASK = 0o777;
const FILE_MODE_OWNER_RW = 0o600;

function keyFileTrusted(stat: Awaited<ReturnType<typeof lstat>>): boolean {
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  if ((Number(stat.mode) & FILE_MODE_MASK) !== FILE_MODE_OWNER_RW) return false;
  // The HMAC key is a long-lived bearer credential; it must belong to the
  // invoking uid where the platform exposes it (uid is undefined on Windows).
  return stat.uid === undefined || stat.uid === process.geteuid?.();
}

type EnvelopeFields = {
  readonly producer: PortfolioProducer;
  readonly report: unknown;
  readonly signatureHex: string;
};

function canonicalizeHmac(producer: PortfolioProducer, report: unknown): string {
  return `${producer}\n${canonicalize(report)}`;
}

function hmacSignature(key: Buffer, producer: PortfolioProducer, report: unknown): `hmac-sha256:${string}` {
  return `hmac-sha256:${createHmac("sha256", key).update(canonicalizeHmac(producer, report)).digest("hex")}`;
}

/** Signs a report or collector-error payload into an authenticated envelope. */
export function signPortfolioEnvelope(payload: PortfolioAuthPayload, key: Buffer): PortfolioAuthEnvelopeV1 {
  const producer = PORTFOLIO_PRODUCERS[payload.source];
  return {
    schema_version: 1,
    producer,
    report: payload,
    signature: hmacSignature(key, producer, payload),
  };
}

export async function readPortfolioHmacKey(path: string): Promise<Buffer> {
  try {
    const initial = await lstat(path);
    if (!keyFileTrusted(initial)) {
      throw new JarvisError("PORTFOLIO_AUTH_INVALID");
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const pinned = await file.stat();
      if (!keyFileTrusted(pinned) || pinned.dev !== initial.dev || pinned.ino !== initial.ino) {
        throw new JarvisError("PORTFOLIO_AUTH_INVALID");
      }
      const buffer = Buffer.alloc(HMAC_KEY_MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead < HMAC_KEY_MIN_BYTES || bytesRead > HMAC_KEY_MAX_BYTES) {
        throw new JarvisError("PORTFOLIO_AUTH_INVALID");
      }
      return buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof JarvisError) throw error;
    throw new JarvisError("PORTFOLIO_AUTH_INVALID");
  }
}

export function verifyPortfolioAuthenticatedReport(
  input: Buffer,
  key: Buffer,
  source: PortfolioEnvironment,
): PortfolioVerifiedPayload {
  const envelope = parseEnvelope(input);
  const expected = createHmac("sha256", key)
    .update(canonicalizeHmac(envelope.producer, envelope.report))
    .digest();
  const actual = Buffer.from(envelope.signatureHex, "hex");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new JarvisError("PORTFOLIO_AUTH_INVALID");
  }
  if (envelope.producer !== PORTFOLIO_PRODUCERS[source]) {
    throw new JarvisError("PORTFOLIO_SOURCE_MISMATCH");
  }
  return parsePortfolioIngest(Buffer.from(JSON.stringify(envelope.report), "utf8"));
}

/** Verifies an authenticated envelope and returns the inner payload bytes. */
export function verifyPortfolioAuthenticatedEnvelope(
  input: Buffer,
  key: Buffer,
  source: PortfolioEnvironment,
): Buffer {
  const parsed = verifyPortfolioAuthenticatedReport(input, key, source);
  return Buffer.from(JSON.stringify(parsed.kind === "report" ? parsed.report : parsed.error), "utf8");
}

function parseEnvelope(input: Buffer): EnvelopeFields {
  if (input.byteLength < 1 || input.byteLength > PORTFOLIO_MAX_BYTES) {
    throw new JarvisError("PORTFOLIO_INPUT_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(input.toString("utf8"));
  } catch {
    throw new JarvisError("PORTFOLIO_INPUT_INVALID");
  }
  if (!isRecord(value)) throw new JarvisError("PORTFOLIO_INPUT_INVALID");
  const actual = Object.keys(value).sort();
  const expected = [...PORTFOLIO_AUTH_ENVELOPE_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new JarvisError("PORTFOLIO_AUTH_REQUIRED");
  }
  if (value.schema_version !== 1) throw new JarvisError("PORTFOLIO_AUTH_INVALID");
  const producer = value.producer;
  if (producer !== "jarvis-local" && producer !== "jarvis-jm-server") {
    throw new JarvisError("PORTFOLIO_AUTH_INVALID");
  }
  if (typeof value.signature !== "string") throw new JarvisError("PORTFOLIO_AUTH_INVALID");
  const matched = HMAC_HEX_PATTERN.exec(value.signature);
  const signatureHex = matched?.[1];
  if (signatureHex === undefined) throw new JarvisError("PORTFOLIO_AUTH_INVALID");
  return { producer, report: value.report, signatureHex };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
