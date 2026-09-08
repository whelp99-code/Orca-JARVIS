import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { JarvisError } from "./db.js";
import { closedObject } from "./evening-closeout-parse-values.js";
import { parseTrustedCloseoutKey } from "./evening-closeout-crypto.js";
import { parseNativeEveningSourceConfig } from "./evening-native-source.js";
import { parseDailyLoopOptions } from "./daily-loop-input.js";
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

export async function readEveningCliInputs(configPath: string, keyPath: string, owner: string, clock: () => Date) {
  try {
    const value = closedObject(JSON.parse((await boundedFile(configPath, 16384)).toString("utf8")),
      ["schema_version", "daily", "source", "trusted_key"]);
    if (value.schema_version !== 1) throw new Error("INVALID_VERSION");
    const daily = closedObject(value.daily, ["time_zone", "lease_ms", "deadline_ms", "recovery_window_ms",
      "recovery_lookback_days", "refresh_freshness_ms", "budgets"]);
    const options = parseDailyLoopOptions({ ...daily as Omit<DailyLoopConfig, "owner_id">, owner_id: owner, clock,
      event_source: { drain: () => [] }, refresh_reader: { read: () => null } });
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
