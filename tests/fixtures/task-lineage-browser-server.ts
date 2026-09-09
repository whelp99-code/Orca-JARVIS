import { resolve } from "node:path";
import { taskPublicationFixture } from "./task-publication-fixture.js";
import { localKey } from "../helpers.js";
import { signCommandApproval } from "../../src/control-plane.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { createDashboardServer } from "../../src/dashboard/server.js";

const fixture = await taskPublicationFixture();
const prior = stageTaskExecution(fixture.db, { ...fixture.request,
  plan: { ...fixture.plan, provider: "claude" }, work_lineage: { schema_version: 1, kind: "original" } }, fixture.now);
fixture.control.decide(signCommandApproval({ schema_version: 1, receipt_id: "reject-prior", request_id: prior.request_id,
  decision: "reject", command_digest: prior.command_digest, signer_principal_id: "test-operator",
  authenticated_session_id: "browser-fixture", key_id: "decision-test", algorithm: "Ed25519",
  issued_at: fixture.now.toISOString(), not_before: fixture.now.toISOString(), expires_at: prior.expires_at,
  nonce: "reject-prior", max_uses: 1, status: "issued" }, localKey(fixture.db)), fixture.now);
const server = createDashboardServer({ db: fixture.db, staticRoot: resolve("dist/dashboard"), host: "127.0.0.1", port: 0 });
process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.address.port}`, root: fixture.root,
  prior_id: prior.request_id, prior_digest: prior.command_digest })}\n`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close(); await server.drain(); await fixture.cleanup();
}
process.stdin.resume();
process.stdin.on("end", () => { void close(); });
process.on("SIGTERM", () => { void close(); });
