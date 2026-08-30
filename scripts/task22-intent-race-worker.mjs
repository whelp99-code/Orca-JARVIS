import { parentPort, workerData } from "node:worker_threads";
import { AuthorityDb, NotificationIntentError, NotificationIntentStore } from "orca-jarvis-shadow";

if (parentPort === null) throw new Error("TASK22_RACE_WORKER_PORT_REQUIRED");
const db = new AuthorityDb(workerData.path);
const store = new NotificationIntentStore(db);
parentPort.postMessage({ kind: "ready" });
parentPort.once("message", message => {
  if (message?.kind !== "go") { db.close(); throw new Error("TASK22_RACE_WORKER_SIGNAL_INVALID"); }
  try {
    const result = store.persist(workerData.entry, workerData.clock);
    parentPort.postMessage({ kind: "result", ok: true, urgency: result.urgency, reason: result.reason });
  } catch (failure) {
    parentPort.postMessage({ kind: "result", ok: false,
      code: failure instanceof NotificationIntentError ? failure.code : "UNEXPECTED_WORKER_ERROR" });
  } finally { db.close(); }
});
