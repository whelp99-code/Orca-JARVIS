import { parseArgs } from "node:util";
import { AuthorityDb } from "./db.js";
import { issueEnrollmentCode } from "./owner-inbox-enrollment.js";

const args = parseArgs({ options: { db: { type: "string" } }, strict: true });
const dbPath = args.values.db;
if (dbPath === undefined || dbPath.length === 0) {
  process.stderr.write("owner-inbox-enrollment-code requires --db\n");
  process.exit(1);
}
const db = new AuthorityDb(dbPath);
const issued = issueEnrollmentCode(db, new Date());
db.close();
process.stdout.write(`${issued.code}\n`);
