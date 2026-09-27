import { JarvisError } from "./jarvis-error.js";

/** SQLite reports a lost write race through these codes; they are contention, never corruption. */
const CONTENTION_CODES = new Set(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT"]);

/**
 * Runs an immediate transaction, reporting a lost write race as the caller's own typed race code.
 * Any other failure is rethrown unchanged so a real fault is never laundered into a race.
 */
export function runImmediate(tx: { immediate: () => void }, raceCode: string): void {
  try {
    tx.immediate();
  } catch (error) {
    if (error instanceof Error && "code" in error && CONTENTION_CODES.has(String(error.code))) {
      throw new JarvisError(raceCode);
    }
    throw error;
  }
}
