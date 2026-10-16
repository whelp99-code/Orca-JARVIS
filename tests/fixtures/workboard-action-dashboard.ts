import Database from "better-sqlite3";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { ActionJournal } from "../../src/workboard/action-journal.js";
import { WorkboardActions, readActionBinding } from "../../src/workboard/actions.js";
import { seedWorkboardFixture, WORKBOARD_FIXTURE_NOW } from "./workboard-fixture.js";
import { actionRequest, startActionAgent } from "./workboard-action-agent.js";
import { migratedTestDatabase } from "./migrated-database.js";

export async function startWorkboardActionDashboard() {
  const root = resolve(".runtime-tmp/workboard"); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "actions-dashboard-"));
  const authority = await migratedTestDatabase(join(directory, "authority.sqlite"), resolve("migrations"));
  const decision = generateKeyPairSync("ed25519"); const verifier = generateKeyPairSync("ed25519");
  const decisionPath = join(directory, "decision.pub.pem"); const verifierPath = join(directory, "verifier.pub.pem");
  writeFileSync(decisionPath, decision.publicKey.export({ type: "spki", format: "pem" }));
  writeFileSync(verifierPath, verifier.publicKey.export({ type: "spki", format: "pem" }));
  await authority.initialize({ decision: { keyId: "fixture-decision", principal: "fixture-owner", publicKeyPath: decisionPath },
    verifier: { keyId: "fixture-verifier", principal: "fixture-verifier", publicKeyPath: verifierPath } });
  seedWorkboardFixture(authority.db);
  const row = authority.db.prepare("SELECT work_id FROM workboard_works WHERE task_id='task-1'").get() as { work_id: string };
  const binding = () => readActionBinding(authority.db, row.work_id, WORKBOARD_FIXTURE_NOW);
  const request = { ...actionRequest(), ...binding() };
  // Replace the deliberately alarming read-only UI seed with disposable action copy.
  authority.db.prepare("UPDATE workboard_works SET summary=? WHERE work_id=?").run("일회용 시험 에이전트의 실행 결정", row.work_id);
  authority.db.prepare("UPDATE workboard_attention SET wait_reason=? WHERE work_id=?").run("시험 작업공간만 처리합니다", row.work_id);
  const agent = await startActionAgent(request);
  const journalDb = new Database(join(directory, "action-journal.sqlite"));
  const actions = new WorkboardActions(new ActionJournal(journalDb), new Map([[row.work_id, agent.adapter]]), binding, () => WORKBOARD_FIXTURE_NOW);
  const staticRoot = resolve("dist/dashboard");
  const server = createDashboardServer({ db: authority, staticRoot, host: "127.0.0.1", port: 0,
    clock: () => WORKBOARD_FIXTURE_NOW, workboardActions: actions,
    secondBrainProbe: { inspect: async () => ({ executable: "missing", configuration: "unavailable", contract_digest: null,
      protocol_version: null, tools: null, schemas_compatible: false, status: "unavailable", doctor: "unavailable",
      handshake: "unavailable", status_operational: null, doctor_operational: null, read_authorization: "unauthorized",
      write_authorization: "unauthorized", data_state: "unknown", refresh: { kind: "missing" } }) } });
  const origin = `http://${server.address.host}:${server.address.port}`;
  const session = await fetch(`${origin}/api/v1/session`).then(r => r.json()) as { csrf_token: string };
  async function post(path: string, body: unknown, csrf = session.csrf_token) {
    const response = await fetch(`${origin}/api/v1/workboard/actions/${path}`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, "X-JARVIS-CSRF": csrf }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() as unknown };
  }
  return { directory, authority, decisionKey: decision.privateKey, actions, agent, server, origin, post, workId: row.work_id, binding,
    async close() { server.close(); await server.drain(); await agent.close(); journalDb.close(); authority.close();
      rmSync(directory, { recursive: true, force: true }); } };
}
