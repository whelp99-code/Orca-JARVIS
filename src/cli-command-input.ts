import { createPrivateKey } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { JarvisError } from "./db.js";

const TEAM_PROPOSAL_MAX_BYTES = 16 * 1024;

export async function privateKeyFile(path: string): Promise<ReturnType<typeof createPrivateKey>> {
  try {
    return createPrivateKey(await readFile(path, "utf8"));
  } catch {
    throw new JarvisError("SIGNING_KEY_MISSING", path);
  }
}

export async function jsonFile<T = unknown>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID");
  }
}

export async function teamProposalFile<T>(path: string): Promise<T> {
  try {
    const initial = await lstat(path);
    if (!initial.isFile() || initial.isSymbolicLink()) throw new JarvisError("TEAM_PROPOSAL_INPUT_INVALID");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const pinned = await file.stat();
      if (!pinned.isFile() || pinned.dev !== initial.dev || pinned.ino !== initial.ino) {
        throw new JarvisError("TEAM_PROPOSAL_INPUT_INVALID");
      }
      const buffer = Buffer.alloc(TEAM_PROPOSAL_MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead < 1 || bytesRead > TEAM_PROPOSAL_MAX_BYTES) {
        throw new JarvisError("TEAM_PROPOSAL_INPUT_INVALID");
      }
      return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof JarvisError) throw error;
    throw new JarvisError("TEAM_PROPOSAL_INPUT_INVALID");
  }
}

export function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID");
  }
  return Object.fromEntries(Object.entries(value));
}

export function typedObject<T extends object>(value: T): T {
  if (Array.isArray(value)) throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID");
  return value;
}

export function integer(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID");
  return parsed;
}

export function providerValue(value: unknown): "codex" | "claude" {
  if (value === "codex" || value === "claude") return value;
  throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID");
}

export function keyPurposeValue(
  value: unknown,
): "progress-signal" | "authority-receipt" | "verification" | "census" {
  if (value === "progress-signal" || value === "authority-receipt" || value === "verification" || value === "census") {
    return value;
  }
  throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID");
}

export function workerCrashValue(value: string | undefined): "before_commit" | "after_commit" | "ambiguous" | undefined {
  if (value === undefined || value === "before_commit" || value === "after_commit" || value === "ambiguous") return value;
  throw new JarvisError("PRE_GJC_CLI_INPUT_INVALID");
}
