import process from "node:process";
import { AuthorityDb, GjcRuntimeService } from "../../dist/src/index.js";
import { GjcCoordinatorClient } from "../../dist/src/gjc.js";

const db = new AuthorityDb(process.argv[2]);
let now = "2026-09-07T00:00:00.000Z";
let resume;
let hold = true;
const client = new GjcCoordinatorClient(async run => {
  const request = JSON.parse(run.stdin.trim().split("\n")[2]).params;
  if (request.name === "gjc_coordinator_read_turn") {
    if (hold) {
      const barrier = new Promise(resolve => { resume = resolve; });
      process.send({ type: "call", pid: process.pid, turn_id: request.arguments.turn_id });
      await barrier;
      hold = false;
    }
  }
  const body = request.name === "gjc_coordinator_list_questions" ? { questions: [] } : {
    ok: true, turn: { status: "completed", session_id: "s", turn_id: request.arguments.turn_id },
  };
  return { exitCode: 0, stdout: [
    { jsonrpc: "2.0", id: 1, result: {
      protocolVersion: "2024-11-05", serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" },
    } },
    { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(body) }] } },
  ].map(item => JSON.stringify(item)).join("\n") };
});
const service = new GjcRuntimeService(db, client, "gjc-runtime", undefined, () => new Date(now));
process.on("message", async message => {
  try {
    if (message.action === "resume") { resume?.(); return; }
    if (message.action === "close") {
      service.close();
      process.send({ type: "released" });
      return;
    }
    now = message.now;
    process.send({ type: "result", ...await service.once() });
  } catch (error) {
    process.send({ type: "error", code: error.code ?? error.message });
  }
});
process.send({ type: "ready", pid: process.pid });
