import { parseBoundedStrictJson } from "./strict-json.js";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { JarvisError } from "./db.js";
import { closedObject } from "./evening-closeout-parse-values.js";
import { parseTrustedCloseoutKey } from "./evening-closeout-crypto.js";
import { parseNativeEveningSourceConfig } from "./evening-native-source.js";
import { parseDailyLoopOptions } from "./daily-loop-input.js";
import { SecondBrainRefreshReceiptReader } from "./second-brain-refresh-receipt.js";
import type { DailyLoopConfig } from "./daily-loop-types.js";
import type { CloseoutSigningHandle } from "./evening-closeout-types.js";

async function boundedFile(path: string, maximum: number, privateFile = false): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum
      || (privateFile && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.geteuid?.()))) throw new Error("INVALID_FILE");
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 1 || bytesRead > maximum) { buffer.fill(0); throw new Error("INVALID_SIZE"); }
    return buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
}

/** The one field this version adds: an absolute path the provider publishes its receipt at. */
function refreshReceiptPath(value: unknown): string {
  const path = closedObject(value, ["receipt_path"])["receipt_path"];
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 512
    || path.includes("\0")) throw new Error("INVALID_REFRESH");
  return path;
}

export async function readEveningCliInputs(configPath: string, keyPath: string, owner: string, clock: () => Date) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await boundedFile(configPath, 16384));
    const document = parseBoundedStrictJson(text, { depth: 32, nodes: 8192, workItems: 32768, characters: 16384 });
    // A provider refresh receipt is a new input, so it arrives as its own declared version rather
    // than as an optional key: version 1 stays exactly the four-field record it always was.
    const version = document !== null && typeof document === "object"
      ? Reflect.get(document, "schema_version") : undefined;
    if (version !== 1 && version !== 2) throw new Error("INVALID_VERSION");
    const value = closedObject(document, version === 2
      ? ["schema_version", "daily", "source", "trusted_key", "refresh"]
      : ["schema_version", "daily", "source", "trusted_key"]);
    const receipts = new SecondBrainRefreshReceiptReader(
      version === 2 ? refreshReceiptPath(value["refresh"]) : undefined);
    const daily = closedObject(value.daily, ["time_zone", "lease_ms", "deadline_ms", "recovery_window_ms",
      "recovery_lookback_days", "refresh_freshness_ms", "budgets"]);
    const options = parseDailyLoopOptions({ ...daily as Omit<DailyLoopConfig, "owner_id">, owner_id: owner, clock,
      event_source: { drain: () => [] },
      refresh_reader: { read: (at: Date) => receipts.read(at) } });
    const source = parseNativeEveningSourceConfig(value.source); const trusted = parseTrustedCloseoutKey(value.trusted_key);
    const bytes = await boundedFile(keyPath, 4096, true);
    const key = (() => { try { return createPrivateKey(bytes); } finally { bytes.fill(0); } })();
    if (key.asymmetricKeyType !== "ed25519") throw new Error("INVALID_KEY");
    const spki = createPublicKey(key).export({ type: "spki", format: "der" });
    if (spki.toString("base64url") !== trusted.public_key_spki) throw new Error("KEY_MISMATCH");
    const signer: CloseoutSigningHandle = { identity: { schema_version: 1, algorithm: "Ed25519", ...trusted,
      public_key_fingerprint: `sha256:${createHash("sha256").update(spki).digest("hex")}` },
    clock, sign: payload => sign(null, payload, key) };
    return { options, source, trusted, signer };
  } catch { throw new JarvisError("DAILY_LOOP_CONFIG_INVALID"); }
}
