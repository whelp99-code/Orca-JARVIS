import Database from "better-sqlite3";

/**
 * Serialises everyone who may create or remove a swap barrier for one database.
 *
 * Reclaiming a dead barrier and taking it are two steps, and a process that does them while
 * another is doing the same can remove a record that has just become somebody's live claim - the
 * pathname is the only handle either of them has, and no filesystem call removes a path only while
 * it still names a known file. So the steps are not made atomic; they are made exclusive. SQLite's
 * own locking is a real kernel lock on a real file, it is already a dependency here, and it is
 * released by the kernel if the holder dies, which is exactly the failure this protocol exists for.
 *
 * Only writers take this. Admission reads the barrier without it and never removes anything, so
 * opening a database costs no lock at all.
 */
export function withSwapBarrierLock<T>(database: string, operation: () => T): T {
  const lock = new Database(`${database}.swap-lock`);
  try {
    lock.pragma("busy_timeout = 10000");
    lock.exec("BEGIN EXCLUSIVE");
    try {
      return operation();
    } finally {
      lock.exec("ROLLBACK");
    }
  } finally {
    lock.close();
  }
}
