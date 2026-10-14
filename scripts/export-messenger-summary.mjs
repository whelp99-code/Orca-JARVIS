// Read-only aggregate of a durable messenger inbox. Never imports the inbox writer:
// that constructor mutates journal mode and schema.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";

const SUCCESS = "ok\n";
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const COLUMNS = [
  ["id", "TEXT", 0, 1],
  ["payload", "TEXT", 1, 0],
  ["state", "TEXT", 1, 0],
  ["received", "INTEGER", 1, 0],
  ["delivered", "INTEGER", 0, 0],
  ["completed", "INTEGER", 0, 0],
  ["evidence", "TEXT", 0, 0],
];

const AGGREGATE = `
SELECT
  COALESCE(SUM(CASE WHEN json_valid(payload) = 0 THEN 1 ELSE 0 END), 0) AS bad_json,
  COALESCE(SUM(CASE
    WHEN json_valid(payload) = 1 AND is_rep = 1 AND excluded = 0
      AND state NOT IN ('pending', 'processing', 'completed') THEN 1 ELSE 0 END), 0) AS bad_state,
  COALESCE(SUM(CASE
    WHEN json_valid(payload) = 1 AND is_rep = 1 AND excluded = 0
      AND NOT (typeof(received) = 'integer' AND received >= 0 AND received <= @now AND received <= ${MAX_SAFE})
    THEN 1 ELSE 0 END), 0) AS bad_received,
  COALESCE(SUM(CASE
    WHEN json_valid(payload) = 1 AND is_rep = 1 AND excluded = 0
      AND state IN ('pending', 'processing')
      AND typeof(received) = 'integer' AND received >= 0 AND received <= @now AND received <= ${MAX_SAFE}
    THEN 1 ELSE 0 END), 0) AS incomplete_count,
  MIN(CASE
    WHEN json_valid(payload) = 1 AND is_rep = 1 AND excluded = 0
      AND state IN ('pending', 'processing')
      AND typeof(received) = 'integer' AND received >= 0 AND received <= @now AND received <= ${MAX_SAFE}
    THEN received END) AS oldest
FROM (
  SELECT
    payload,
    state,
    received,
    CASE
      WHEN json_type(payload, '$.user') = 'text' AND json_extract(payload, '$.user') = @uid THEN 1
      ELSE 0
    END AS is_rep,
    CASE
      WHEN (json_type(payload, '$.bot_id') IS NOT NULL AND json_type(payload, '$.bot_id') != 'null')
        OR json_extract(payload, '$.subtype') IN ('bot_message', 'message_changed', 'message_deleted')
      THEN 1 ELSE 0
    END AS excluded
  FROM events
)`;

class Coded extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function emit(code) {
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}

function requireAbsolute(path, code) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path) || resolve(path) !== path) throw new Coded(code);
  return path;
}

function sourceOk(path) {
  const source = requireAbsolute(path, "SOURCE_INVALID");
  let stat;
  try {
    stat = lstatSync(source);
    if (realpathSync(source) !== source) throw new Coded("SOURCE_INVALID");
  } catch {
    throw new Coded("SOURCE_INVALID");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Coded("SOURCE_INVALID");
  return source;
}

function outputOk(path, source) {
  const output = requireAbsolute(path, "OUTPUT_INVALID");
  const forbidden = new Set([source, `${source}-wal`, `${source}-shm`, `${source}-journal`]);
  if (forbidden.has(output)) throw new Coded("OUTPUT_INVALID");
  const dir = dirname(output);
  let dirStat;
  try {
    dirStat = lstatSync(dir);
    if (realpathSync(dir) !== dir) throw new Coded("OUTPUT_INVALID");
  } catch {
    throw new Coded("OUTPUT_INVALID");
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Coded("OUTPUT_INVALID");
  if (dirStat.uid !== process.getuid()) throw new Coded("OUTPUT_INVALID");
  if ((dirStat.mode & 0o022) !== 0) throw new Coded("OUTPUT_INVALID");
  try {
    const dest = lstatSync(output);
    if (dest.isSymbolicLink() || !dest.isFile()) throw new Coded("OUTPUT_INVALID");
  } catch (error) {
    if (error instanceof Coded) throw error;
    if (error?.code !== "ENOENT") throw new Coded("OUTPUT_INVALID");
  }
  return output;
}

function schemaOk(db) {
  const master = db.prepare("SELECT type FROM sqlite_master WHERE name = 'events'").get();
  if (master?.type !== "table") return false;
  const cols = db.prepare(
    `SELECT name, type, "notnull" AS nn, pk, dflt_value FROM pragma_table_info('events') ORDER BY cid`,
  ).all();
  if (cols.length !== COLUMNS.length) return false;
  return COLUMNS.every((expected, index) => {
    const col = cols[index];
    if (col?.name !== expected[0] || String(col.type).toUpperCase() !== expected[1]) return false;
    if (col.nn !== expected[2] || col.pk !== expected[3]) return false;
    if (expected[0] === "id" && col.pk !== 1) return false;
    if (expected[0] === "state" && col.dflt_value !== "'pending'") return false;
    return true;
  });
}

function asCount(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Coded("RECORD_INVALID");
  }
  return value;
}

function aggregate(db, uid, now) {
  db.exec("BEGIN");
  try {
    if (!schemaOk(db)) throw new Coded("SCHEMA_INVALID");
    const row = db.prepare(AGGREGATE).get({ uid, now });
    if (asCount(row?.bad_json) !== 0 || asCount(row?.bad_state) !== 0 || asCount(row?.bad_received) !== 0) {
      throw new Coded("RECORD_INVALID");
    }
    const incomplete = asCount(row?.incomplete_count);
    const oldest = row?.oldest ?? null;
    if (incomplete === 0) {
      if (oldest !== null) throw new Coded("RECORD_INVALID");
      return { incomplete_count: 0, oldest_incomplete_age_ms: null };
    }
    if (typeof oldest !== "number" || !Number.isSafeInteger(oldest) || oldest < 0 || oldest > now) {
      throw new Coded("RECORD_INVALID");
    }
    const age = now - oldest;
    if (!Number.isSafeInteger(age) || age < 0) throw new Coded("RECORD_INVALID");
    return { incomplete_count: incomplete, oldest_incomplete_age_ms: age };
  } finally {
    db.exec("ROLLBACK");
  }
}

function fsyncDirectory(dir) {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function publish(dir, output, bytes) {
  const tmp = join(dir, `.messenger-summary.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd;
  let created = false;
  let renamed = false;
  try {
    fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o640);
    created = true;
    fchmodSync(fd, 0o640);
    let offset = 0;
    while (offset < bytes.length) {
      const wrote = writeSync(fd, bytes, offset);
      if (wrote <= 0) throw new Coded("PUBLISH_FAILED");
      offset += wrote;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const mode = lstatSync(tmp).mode & 0o777;
    if (mode !== 0o640 || lstatSync(tmp).isSymbolicLink()) throw new Coded("PUBLISH_FAILED");
    renameSync(tmp, output);
    renamed = true;
    fsyncDirectory(dir);
    if ((lstatSync(output).mode & 0o777) !== 0o640 || !lstatSync(output).isFile()) {
      throw new Coded("PUBLISH_FAILED");
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (created && !renamed) unlinkSync(tmp);
    throw error;
  }
}

async function snapshotSource(source) {
  const scratch = mkdtempSync(join(tmpdir(), "messenger-export-"));
  const snapshot = join(scratch, "inbox.sqlite");
  let live;
  let ready = false;
  try {
    live = new Database(source, { readonly: true, fileMustExist: true });
    try {
      await live.backup(snapshot);
      ready = true;
    } catch (error) {
      if (error instanceof Coded) throw error;
      throw new Coded("SCHEMA_INVALID");
    }
  } finally {
    live?.close();
    if (!ready) rmSync(scratch, { recursive: true, force: true });
  }
  return { scratch, snapshot };
}

async function openSnapshot(source) {
  const { scratch, snapshot } = await snapshotSource(source);
  let db;
  try {
    db = new Database(snapshot, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    if (error instanceof Coded) throw error;
    throw new Coded("SCHEMA_INVALID");
  }
  return { db, scratch };
}

export { openSnapshot, snapshotSource };

export function summarizeDatabase(db, uid) {
  const observedMillis = Date.now();
  return { observedMillis, summary: aggregate(db, uid, observedMillis) };
}

export { aggregate };

function readFlags() {
  let values;
  try {
    values = parseArgs({
      options: {
        inbox: { type: "string" },
        "representative-user-id": { type: "string" },
        output: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new Coded("USAGE");
  }
  const uid = values["representative-user-id"];
  if (typeof values.inbox !== "string" || typeof values.output !== "string" || typeof uid !== "string") {
    throw new Coded("USAGE");
  }
  if (!/^[UW][A-Z0-9]{1,127}$/.test(uid)) throw new Coded("USAGE");
  return { inbox: values.inbox, uid, output: values.output };
}

async function main() {
  const flags = readFlags();
  const source = sourceOk(flags.inbox);
  const output = outputOk(flags.output, source);
  let db;
  let scratch;
  try {
    ({ db, scratch } = await openSnapshot(source));
    const { observedMillis, summary } = summarizeDatabase(db, flags.uid);
    const bytes = Buffer.from(`${JSON.stringify({
      schema_version: 1,
      observed_at: new Date(observedMillis).toISOString(),
      incomplete_count: summary.incomplete_count,
      oldest_incomplete_age_ms: summary.oldest_incomplete_age_ms,
    })}\n`);
    publish(dirname(output), output, bytes);
  } finally {
    db?.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
  process.stdout.write(SUCCESS);
}

try {
  await main();
} catch (error) {
  emit(error instanceof Coded ? error.code : "PUBLISH_FAILED");
}
