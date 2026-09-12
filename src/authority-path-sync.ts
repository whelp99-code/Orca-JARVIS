import { closeSync, fsyncSync, openSync } from "node:fs";

export function syncPath(path: string, directory = false): void {
  const descriptor = openSync(path, directory ? "r" : "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/**
 * Takes the source's write lock so the question that follows and the close that ends it cannot
 * have a commit between them. A commit there is invisible to an answer already read and is folded
 * into whatever state is taken afterwards, which is how a row ends up in a retired copy and in
 * nothing else. A writer already holding the database makes this fail, and that is a refusal
 * before anything has been destroyed.
 */
export function holdSourceExclusively(database: { exec: (sql: string) => unknown }): boolean {
  try {
    database.exec("BEGIN EXCLUSIVE");
    return true;
  } catch { return false; }
}
