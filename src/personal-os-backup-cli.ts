import { parseArgs } from "node:util";
import { join } from "node:path";
import {
  backupProductionSqlite,
  backupSqlite,
  type BackupResult,
} from "./personal-os-backup.js";
import { PersonalOsError } from "./personal-os-errors.js";

export type BackupCliDependencies = {
  readonly isolatedBackup?: typeof backupSqlite;
  readonly productionBackup?: typeof backupProductionSqlite;
  readonly now?: () => Date;
  readonly write?: (line: string) => void;
};

export async function runBackupCli(
  argv: readonly string[],
  dependencies: BackupCliDependencies = {},
): Promise<BackupResult> {
  let values: { db?: string; "backup-root"?: string; production?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        db: { type: "string" },
        "backup-root": { type: "string" },
        production: { type: "boolean" },
      },
      strict: true,
    }));
  } catch {
    throw new PersonalOsError("E_USAGE");
  }
  if (values.db === undefined || values["backup-root"] === undefined) throw new PersonalOsError("E_USAGE");
  const mode = values.production === true ? "production" : "isolated";
  const result = mode === "production"
    ? await (dependencies.productionBackup ?? backupProductionSqlite)({
      sourcePath: values.db,
      backupRoot: values["backup-root"],
      now: dependencies.now?.(),
    })
    : await (dependencies.isolatedBackup ?? backupSqlite)({
      sourcePath: values.db,
      destPath: join(values["backup-root"], "jarvis-rehearsal.sqlite"),
    });
  (dependencies.write ?? (line => { process.stdout.write(`${line}\n`); }))(
    JSON.stringify({ ok: true, mode, ...result }),
  );
  return result;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url.endsWith("personal-os-backup-cli.js")) {
  runBackupCli(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof PersonalOsError ? error.code : "E_BACKUP_FAILED";
    process.stderr.write(`${code}\n`);
    process.exit(2);
  });
}
