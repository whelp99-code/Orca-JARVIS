import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AuthorityDb } from "../../../dist/src/db.js";
import { createDashboardServer } from "../../../dist/src/dashboard/server.js";
const db = new AuthorityDb("/dev/shm/jfc.1KGFZ5/qa-server/jarvis.sqlite");
const server = createDashboardServer({ db, staticRoot: fileURLToPath(new URL("../../../dist/dashboard", import.meta.url)),
  host: "127.0.0.1", port: 0, clock: () => new Date("2026-10-16T09:00:00.000Z") });
writeFileSync("/dev/shm/jfc.1KGFZ5/qa-other-ready.json", JSON.stringify({
  origin: `http://127.0.0.1:${server.address.port}`, label: "TEST_ONLY independent recipient session",
}), { mode: 0o600 });
console.log(`QA_OTHER_READY http://127.0.0.1:${server.address.port}`);
process.on("SIGTERM", () => { server.close(); void server.drain().then(() => { db.close(); process.exit(0); }); });
