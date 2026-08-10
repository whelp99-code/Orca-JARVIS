import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const fail = () => { process.stderr.write("E_SIGNAL_FAIL_CLOSED\n"); process.exitCode = 1; };
try {
  const distIndex = join(process.cwd(), "dist/src/index.js");
  if (!existsSync(distIndex)) execFileSync("npm", ["run", "build"], { stdio: "ignore" });
  if (!existsSync(distIndex)) throw new Error("missing compiled acceptance module");
  const { AuthorityDb, runPreGjcFixture } = await import(pathToFileURL(distIndex).href);
  const { values } = parseArgs({ options: { fixture: { type: "string" }, clock: { type: "string" } }, strict: true });
  if (!values.fixture || !values.clock) throw new Error("missing gate input");
  const fixture = JSON.parse(await readFile(values.fixture, "utf8"));
  const db = new AuthorityDb(join(mkdtempSync(join(tmpdir(), "orca-pre-gjc-")), "shadow.sqlite"));
  try { await db.migrate(); process.stdout.write(`${JSON.stringify(runPreGjcFixture(db, fixture, values.clock))}\n`); } finally { db.close(); }
} catch { fail(); }
