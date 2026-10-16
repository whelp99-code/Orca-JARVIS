import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../../src/canonical.js";
import { companyApproverFixture } from "./company-approver-execution.js";

const worker = fileURLToPath(new URL("../../dist/tests/fixtures/company-freshness-broker-worker.mjs", import.meta.url));
const peer = fileURLToPath(new URL("../../dist/tests/fixtures/company-freshness-wire-peer.mjs", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** A signature-checking wire peer, not a production SB provider or effect-verification substitute. */
export async function companyFreshnessBroker(options: { enabled?: boolean; oversized?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jfb-"));
  chmodSync(root, 0o700);
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const fixture = companyApproverFixture();
  const command = fixture.command;
  const socket = join(root, "broker.sock");
  const capture = join(root, "capture.json");
  const privateKey = join(root, "progress.pem");
  const client = join(root, "client.json");
  const brokerConfig = join(root, "broker.json");
  const sbConfig = join(root, "process.json");
  const freshnessConfig = join(root, "freshness.json");
  const binary = join(root, "sb-company");
  const ready = join(root, "ready");
  const write = (path: string, value: unknown) => writeFileSync(path, canonicalize(value), { mode: 0o600 });
  writeFileSync(privateKey, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  write(client, { schema_version: 2, role: "freshness", socket, signing_key_id: "key:progress", signing_key_file: privateKey,
    context: { provider_instance_id: command.target.provider_instance_id, workspace_id: command.target.workspace_id,
      principal_id: "principal:jarvis-company-progress", agent_id: "agent:progress", session_id: "session:progress",
      projects: command.args.projects, policy_revision: command.args.policy_revision,
      deletion_sequence: command.args.deletion_sequence, deletion_set_root: command.args.deletion_set_root } });
  write(sbConfig, { forbidden_process_config: true });
  write(freshnessConfig, { public_key: publicKey, capture, oversized: options.oversized ?? false });
  writeFileSync(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(peer)} "$@"\n`, { mode: 0o700 });
  write(brokerConfig, { schema_version: 1, role: "processor", socket, sb_company_bin: binary, sb_config_file: sbConfig,
    ...(options.enabled === false ? {} : { freshness_config_file: freshnessConfig }) });
  const listening = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error("Broker fixture did not become ready")); }, 5_000);
    const watcher = watch(root, (_event, name) => {
      if (name !== "ready" || !existsSync(ready)) return;
      clearTimeout(timer); watcher.close(); resolve();
    });
  });
  const child = spawn(process.execPath, [worker, brokerConfig, ready], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SB_COMPANY_DATABASE: "/forbidden/override", PYTHONPATH: "/forbidden/python" },
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "close", { signal: AbortSignal.timeout(5_000) });
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  };
  try { await listening; }
  catch (error) {
    await close();
    throw new Error(`${String(error)} ${Buffer.concat(stderr).toString("utf8")}`);
  }
  return { root, socket, client, privateKey, publicKey, freshnessConfig, capture, fixture, close,
    captured: (): unknown => existsSync(capture) ? JSON.parse(readFileSync(capture, "utf8")) : null };
}
