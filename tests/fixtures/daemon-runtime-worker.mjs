import process from "node:process";
import { AuthorityDb } from "../../dist/src/db.js";
import { GjcRuntimeService } from "../../dist/src/service.js";
import { GjcCoordinatorClient } from "../../dist/src/gjc.js";
const db = new AuthorityDb(process.argv[2]);
const service = new GjcRuntimeService(db, new GjcCoordinatorClient(async () => { throw new Error("unexpected coordinator call"); }));
process.on("message", async message => {
  try {
    if (message.action === "once") process.send({ result: await service.once() });
    else if (message.action === "release") { service.close(); process.send({ released: true }); }
    else throw new Error("invalid fixture action");
  } catch (error) { process.send({ error: error.code ?? error.message }); }
});
process.on("disconnect", () => { service.close(); db.close(); process.exit(0); });
process.send({ ready: true, pid: process.pid });
