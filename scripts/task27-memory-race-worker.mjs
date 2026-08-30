import { parentPort, workerData } from "node:worker_threads";
import {
  AuthorityDb,
  MemoryCandidateError,
  MemoryCandidateStore,
} from "orca-jarvis-shadow";

if (parentPort === null) throw new Error("TASK27_RACE_WORKER_PORT_REQUIRED");
const authority = new AuthorityDb(workerData.path);
const store = new MemoryCandidateStore(
  authority,
  workerData.policy,
  () => new Date(workerData.clock),
);
parentPort.postMessage({ kind: "ready" });
parentPort.once("message", message => {
  if (message?.kind !== "go") {
    authority.close();
    throw new Error("TASK27_RACE_WORKER_SIGNAL_INVALID");
  }
  try {
    const result = store.classify(workerData.input);
    parentPort.postMessage({
      kind: "result",
      ok: true,
      candidate_id: result.candidate_id,
      classification_digest: result.classification_digest,
      state: result.state,
    });
  } catch (error) {
    parentPort.postMessage({
      kind: "result",
      ok: false,
      code: error instanceof MemoryCandidateError ? error.code : "UNEXPECTED_WORKER_ERROR",
    });
  } finally {
    authority.close();
  }
});
