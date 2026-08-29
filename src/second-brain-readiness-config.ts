import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  parseSecondBrainConfigWithPython,
  type SecondBrainConfigParser,
} from "./second-brain-config-python.js";

export const SECOND_BRAIN_CONFIG_MAX_BYTES = 65_536;
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export type SecondBrainConfigurationOutcome = "valid" | "missing" | "malformed" | "unavailable";

type ConfigurationMetadata = {
  readonly size: number;
  isFile(): boolean;
};
type ConfigurationRead = {
  readonly bytesRead: number;
};
export type SecondBrainConfigurationHandle = {
  stat(): Promise<ConfigurationMetadata>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<ConfigurationRead>;
  close(): Promise<void>;
};
export type SecondBrainConfigurationOpener = {
  open(path: string, flags: number): Promise<SecondBrainConfigurationHandle>;
};

const defaultOpener: SecondBrainConfigurationOpener = { open };

export async function probeSecondBrainConfiguration(
  path: string,
  opener: SecondBrainConfigurationOpener = defaultOpener,
  parser: SecondBrainConfigParser = parseSecondBrainConfigWithPython,
): Promise<SecondBrainConfigurationOutcome> {
  let handle: SecondBrainConfigurationHandle;
  try {
    handle = await opener.open(path, OPEN_FLAGS);
  } catch (error) {
    if (!(error instanceof Error)) return "unavailable";
    return errorCode(error) === "ENOENT" ? "missing"
      : errorCode(error) === "ELOOP" ? "malformed" : "unavailable";
  }
  let outcome: SecondBrainConfigurationOutcome = "unavailable";
  let closed = true;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > SECOND_BRAIN_CONFIG_MAX_BYTES) {
      outcome = "malformed";
    } else {
      const bytes = await readBounded(handle);
      outcome = bytes === undefined ? "malformed" : await parser(bytes);
    }
  } catch {
    outcome = "unavailable";
  } finally {
    try {
      await handle.close();
    } catch {
      closed = false;
    }
  }
  return closed ? outcome : "unavailable";
}

async function readBounded(handle: SecondBrainConfigurationHandle): Promise<Uint8Array | undefined> {
  const buffer = Buffer.alloc(SECOND_BRAIN_CONFIG_MAX_BYTES + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.byteLength - offset) return undefined;
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset < 1 || offset > SECOND_BRAIN_CONFIG_MAX_BYTES) return undefined;
  return buffer.subarray(0, offset);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}
