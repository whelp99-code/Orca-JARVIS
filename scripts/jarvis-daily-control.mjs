#!/usr/bin/env node
import { AuthorityDb } from "../dist/src/db.js";
import { DailyControlRuntime } from "../dist/src/daily-control-runtime.js";

const dbPath = process.env.JARVIS_DB;
if (!dbPath) { process.stderr.write("JARVIS_DB_REQUIRED\n"); process.exitCode = 2; }
else {
  const db = new AuthorityDb(dbPath);
  try {
    await db.migrate();
    await db.assertMigrationsReady();
    const runtime = new DailyControlRuntime({ db });
    if (process.argv[2] === "run") {
      const stop = await (await import("../dist/src/daily-control-runtime.js")).startDailyControlRuntime({ db });
      process.once("SIGTERM", () => { stop(); db.close(); });
      process.once("SIGINT", () => { stop(); db.close(); });
      await new Promise(() => undefined);
    } else if (process.argv[2] === "status") process.stdout.write(`${JSON.stringify(runtime.status())}\n`);
    else process.stdout.write(`${JSON.stringify(await runtime.once())}\n`);
    if (process.argv[2] !== "run") db.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : "DAILY_CONTROL_FAILED";
    const code = /^[A-Z][A-Z0-9_]+$/u.test(message) ? message : "DAILY_CONTROL_FAILED";
    process.stderr.write(`${code}\n`);
    db.close();
    process.exitCode = 2;
  }
}
