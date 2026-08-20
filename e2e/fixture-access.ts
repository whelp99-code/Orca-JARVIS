import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_PORT,
  type FixtureMetadata,
} from "../tests/fixtures/dashboard-fixture-ids.js";
import { protectedFingerprint } from "../tests/fixtures/dashboard-fingerprint.js";
import { signFixtureReceipt } from "../tests/fixtures/dashboard-sign-receipt.js";

export function metadataPathFor(port: number): string {
  const name = port === EMPTY_PORT ? "empty.json" : `seeded-${String(port)}.json`;
  return join(process.cwd(), ".tmp-e2e", name);
}

export function readMetadata(baseURL: string): FixtureMetadata {
  const port = Number(new URL(baseURL).port);
  return JSON.parse(readFileSync(metadataPathFor(port), "utf8")) as FixtureMetadata;
}

export function fingerprintFor(baseURL: string): string {
  return protectedFingerprint(readMetadata(baseURL).dbPath);
}

export function signedReceiptFor(
  baseURL: string,
  requestId: string,
  decision: "approve" | "reject",
  untrusted = false,
): string {
  const metadata = readMetadata(baseURL);
  return JSON.stringify(signFixtureReceipt({
    dbPath: metadata.dbPath,
    decisionKeyPath: metadata.decisionKeyPath,
    requestId,
    decision,
    untrusted,
  }));
}
