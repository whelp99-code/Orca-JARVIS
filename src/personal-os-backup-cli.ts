import { parseArgs } from "node:util";
import { join } from "node:path";
import { backupSqlite } from "./personal-os-backup.js";
import { PersonalOsError } from "./personal-os-errors.js";

export async function runBackupCli(argv: readonly string[]): Promise<void> {
  let values: { db?: string; "backup-root"?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { db: { type: "string" }, "backup-root": { type: "string" } },
      strict: true,
    }));
  } catch {
    throw new PersonalOsError("E_USAGE");
  }
  if (values.db === undefined || values["backup-root"] === undefined) throw new PersonalOsError("E_USAGE");
  const stamp = "rehearsal";
  const result = await backupSqlite({
    sourcePath: values.db,
    destPath: join(values["backup-root"], `jarvis-${stamp}.sqlite`),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url.endsWith("personal-os-backup-cli.js")) {
  runBackupCli(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof PersonalOsError ? error.code : "E_BACKUP_FAILED";
    process.stderr.write(`${code}\n`);
    process.exit(2);
  });
}
