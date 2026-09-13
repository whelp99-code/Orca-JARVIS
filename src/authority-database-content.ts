import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import { openUnderSwapAdmission } from "./authority-database-swap-barrier.js";
import { JarvisError } from "./jarvis-error.js";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Transient content fence: exact SQL values and row identities, independent of checkpoint bytes. */
export function authorityContentDigest(database: Database.Database): string {
  const ownRead = !database.inTransaction;
  if (ownRead) database.exec("BEGIN");
  try {
    const hash = createHash("sha256");
    const schema = database.prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name",
    ).raw().all();
    hash.update(serialize(schema));
    const tables = database.prepare(
      "SELECT name,wr,type FROM pragma_table_list WHERE schema='main' AND type IN ('table','virtual','shadow') ORDER BY name",
    ).all() as { name: string; wr: number; type: string }[];
    // Shipped authority schemas have no virtual tables. A module may expose external or
    // nondeterministic data, so neither silently skipping it nor hashing its output proves it.
    if (tables.some(table => table.type === "virtual")) {
      throw new JarvisError("AUTHORITY_SOURCE_VIRTUAL_TABLE_UNSUPPORTED");
    }
    for (const { name, wr } of tables) {
      // sqlite_schema is already included above, including indexes and triggers.
      if (name === "sqlite_schema") continue;
      const columns = database.prepare(`PRAGMA table_xinfo(${quote(name)})`).all() as { name: string }[];
      const rowid = ["_rowid_", "rowid", "oid"].find(alias =>
        !columns.some(column => column.name.toLowerCase() === alias));
      if (wr === 0 && rowid === undefined) throw new JarvisError("MEMORY_SOURCE_ROW_IDENTITY_UNREADABLE");
      const selection = wr === 0 ? `${quote(rowid!)},*` : "*";
      const rows: string[] = [];
      for (const values of database.prepare(`SELECT ${selection} FROM ${quote(name)}`)
        .raw().safeIntegers(true).iterate()) {
        // V8 serialization preserves bigint/REAL/NULL/BLOB distinctions within this process.
        rows.push(createHash("sha256").update(serialize(values)).digest("hex"));
      }
      // Preserve duplicate multiplicity while making the fence independent of scan order.
      hash.update(serialize([name, rows.sort()]));
    }
    return hash.digest("hex");
  } finally {
    if (ownRead) database.exec("ROLLBACK");
  }
}

export function withAuthorityContentProbe<T>(filename: string, read: (probe: Database.Database) => T): T {
  const probe = openUnderSwapAdmission(filename, () =>
    new Database(filename, { readonly: true, fileMustExist: true }));
  try { return read(probe); } finally { probe.close(); }
}
