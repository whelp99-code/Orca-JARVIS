import { parentPort, workerData } from "node:worker_threads";
import { AuthorityDb, DailyLoopError, DailyLoopStore } from "orca-jarvis-shadow";

if (parentPort === null) throw new Error("TASK20_RACE_WORKER_PORT_REQUIRED");
const db = new AuthorityDb(workerData.path);
const store = new DailyLoopStore(db);
parentPort.postMessage({ kind: "ready" });
parentPort.once("message", message => {
  if (message?.kind !== "go") { db.close(); throw new Error("TASK20_RACE_WORKER_SIGNAL_INVALID"); }
  try {
    const at = new Date(workerData.at);
    const claim = store.claim({ run_id: workerData.runId, owner_id: workerData.owner, at, lease_ms: workerData.leaseMs });
    store.start(claim, at);
    parentPort.postMessage({ kind: "result", ok: true, fence: claim.fence, owner: claim.owner_id });
  } catch (failure) {
    if (failure instanceof DailyLoopError) parentPort.postMessage({ kind: "result", ok: false, code: failure.code });
    else parentPort.postMessage({ kind: "result", ok: false, code: "UNEXPECTED_WORKER_ERROR" });
  } finally { db.close(); }
});
