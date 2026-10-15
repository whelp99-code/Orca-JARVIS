import { createHash } from "node:crypto";
import childProcess, { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CompanyCandidateExecutor } from "../../src/company-candidate-execution.js";
import { createCompanyCompletionVerifierV2, type CompanyCompletionV2, type CompanyCompletionVerifierV2 } from "../../src/company-completion-v2.js";
import { createCompanyClient, type CompanyClient } from "../../src/company-candidate-transport.js";
import { transitionReadResponseSchema } from "../../src/company-transition-read.js";
import { JarvisError } from "../../src/jarvis-error.js";
import { AuthorityDb } from "../../src/db.js";
import {
  companyApproverProcessorContext, companyApproverV2Database, startJarvisCompanyTestPeer, type JarvisTestPeerMode,
} from "../fixtures/company-approver-execution.js";

const PROCESSOR_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEINyiCKGU4D8nebjrzYdRP/Z6Z+531zOwNB2AxeB3uGuw
-----END PRIVATE KEY-----
`;
const ACTIVE = new Date("2026-10-15T00:05:00.000Z");
const EXPIRED = new Date("2026-10-16T00:00:00.000Z");

function processorConfig(root: string, socketPath: string): string {
  const keyPath = join(root, "key.pem");
  const configPath = join(root, "client.json");
  writeFileSync(keyPath, PROCESSOR_PEM, { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({
    schema_version: 1, role: "processor", context: companyApproverProcessorContext(),
    socket: socketPath, signing_key_id: "key:processor", signing_key_file: keyPath,
  }), { mode: 0o600 });
  return configPath;
}

async function withPeer(mode: JarvisTestPeerMode, decision: "approve" | "reject" = "approve") {
  const live = await companyApproverV2Database(decision);
  const peer = await startJarvisCompanyTestPeer(mode);
  const config = processorConfig(live.root, peer.socketPath);
  const client = createCompanyClient(config, "processor");
  return { live, peer, client };
}

describe("company candidate execution v2", () => {
  it("denies a new mutation after command expiry without calling the peer", async () => {
    const session = await withPeer("ok");
    try {
      const executor = new CompanyCandidateExecutor(session.live.db, session.client, undefined, () => EXPIRED, session.live.provider);
      await expect(executor.execute(session.live.command.request_id)).rejects.toThrow(JarvisError);
      expect(session.peer.counts()).toEqual({ accept: 0, reject: 0, mark_processed: 0, read: 0 });
    } finally { await session.peer.close(); session.live.close(); }
  });

  it("does not resend a lost accept ack and stores the original receipt time", async () => {
    const session = await withPeer("drop-once");
    const now = ACTIVE;
    try {
      const executor = new CompanyCandidateExecutor(session.live.db, session.client, undefined, () => now, session.live.provider);
      await expect(executor.execute(session.live.command.request_id)).rejects.toMatchObject({ code: "COMPANY_CANDIDATE_RESPONSE_INVALID" });
      expect(session.peer.counts().accept).toBe(1);
      const committed = session.peer.receipts();
      const restarted = new AuthorityDb(session.live.db.filename);
      let recovered;
      try {
        recovered = await new CompanyCandidateExecutor(restarted, session.client, undefined, () => now, session.live.provider)
          .execute(session.live.command.request_id);
      } finally { restarted.close(); }
      expect(session.peer.receipts()).toBe(committed);
      expect(session.peer.counts()).toMatchObject({ accept: 1, mark_processed: 0, read: 1 });
      expect(recovered.state).toBe("accepted");
      const payload = JSON.parse(String(session.live.db.db.prepare(
        "SELECT payload_json FROM company_candidate_sb_receipts WHERE operation='accept'",
      ).pluck().get()));
      expect(payload.accepted_at).toBe("2026-10-15T00:02:00.000Z");
      expect(payload.decision_at).toBe("2026-10-15T00:02:00.000Z");
      expect(payload.accepted_at).not.toBe(session.live.approval.issued_at);
    } finally { await session.peer.close(); session.live.close(); }
  });

  it("recovers a rejected ack after expiry without mark_processed or a resend", async () => {
    const session = await withPeer("drop-once", "reject");
    let now = ACTIVE;
    try {
      const executor = new CompanyCandidateExecutor(session.live.db, session.client, undefined, () => now, session.live.provider);
      await expect(executor.execute(session.live.command.request_id)).rejects.toMatchObject({ code: "COMPANY_CANDIDATE_RESPONSE_INVALID" });
      now = EXPIRED;
      const committed = session.peer.receipts();
      const restarted = new AuthorityDb(session.live.db.filename);
      let recovered;
      try {
        recovered = await new CompanyCandidateExecutor(restarted, session.client, undefined, () => now, session.live.provider)
          .execute(session.live.command.request_id);
      } finally { restarted.close(); }
      expect(session.peer.receipts()).toBe(committed);
      expect(recovered.state).toBe("rejected");
      expect(session.peer.counts()).toEqual({ accept: 0, reject: 1, mark_processed: 0, read: 1 });
      const payload = JSON.parse(String(session.live.db.db.prepare(
        "SELECT payload_json FROM company_candidate_sb_receipts WHERE operation='reject'",
      ).pluck().get()));
      expect(payload.decision_at).toBe("2026-10-15T00:02:00.000Z");
      expect(payload.accepted_at).toBeNull();
    } finally { await session.peer.close(); session.live.close(); }
  });

  it("keeps an invalid lookup uncertain and does not resend", async () => {
    const session = await withPeer("drop-bad-echo");
    try {
      const executor = new CompanyCandidateExecutor(session.live.db, session.client, undefined, () => ACTIVE, session.live.provider);
      await expect(executor.execute(session.live.command.request_id)).rejects.toBeInstanceOf(JarvisError);
      await expect(executor.execute(session.live.command.request_id)).rejects.toMatchObject({ code: "COMPANY_SB_RECEIPT_INVALID" });
      expect(session.peer.counts().accept).toBe(1);
      expect(session.peer.counts().read).toBe(1);
      expect(session.live.db.db.prepare("SELECT count(*) AS n FROM company_candidate_sb_receipts").get()).toEqual({ n: 0 });
    } finally { await session.peer.close(); session.live.close(); }
  });

  it("refuses a cached found lookup when the current endpoint has no receipt", async () => {
    const session = await withPeer("drop-once");
    const effect = join(session.live.root, "forbidden-replay-effect");
    let cached: unknown;
    const capturing: CompanyClient = {
      ...session.client,
      async call(...args: Parameters<CompanyClient["call"]>) {
        const result = await session.client.call(...args);
        if (args[0] === "read_transition_receipt") {
          cached = result;
          throw new JarvisError("COMPANY_CANDIDATE_RESPONSE_INVALID");
        }
        return result;
      },
    };
    try {
      await expect(new CompanyCandidateExecutor(session.live.db, session.client, undefined, () => ACTIVE, session.live.provider)
        .execute(session.live.command.request_id)).rejects.toMatchObject({ code: "COMPANY_CANDIDATE_RESPONSE_INVALID" });
      await expect(new CompanyCandidateExecutor(session.live.db, capturing, undefined, () => ACTIVE, session.live.provider)
        .execute(session.live.command.request_id)).rejects.toMatchObject({ code: "COMPANY_CANDIDATE_RESPONSE_INVALID" });
      const old = transitionReadResponseSchema.parse(cached);
      expect(old.outcome).toBe("found");
      writeFileSync(join(session.peer.root, "counts.json.receipts.json"), "{}", { mode: 0o600 });
      const current = transitionReadResponseSchema.parse(
        await session.client.call("read_transition_receipt", old.selector, ACTIVE),
      );
      expect(current.outcome).toBe("not_found");
      expect(current.lookup_request_digest).toBe(old.lookup_request_digest);
      expect(current.lookup_nonce).not.toBe(old.lookup_nonce);
      const replaying: CompanyClient = {
        ...session.client,
        call: async (...args: Parameters<CompanyClient["call"]>) => args[0] === "read_transition_receipt"
          ? old : session.client.call(...args),
      };
      const verifier: CompanyCompletionVerifierV2 = {
        version: 2,
        async verify(command, acceptance, commandDigest) {
          writeFileSync(effect, "must not execute from stale lookup", { mode: 0o600, flag: "wx" });
          return { schema_version: 2, state: "completed", request_id: command.request_id,
            command_digest: commandDigest, candidate_id: command.target.candidate_id,
            content_digest: command.target.content_digest, acceptance_receipt_digest: acceptance.receipt_digest,
            effect_digest: `sha256:${createHash("sha256").update(readFileSync(effect)).digest("hex")}` };
        },
      };

      await expect(new CompanyCandidateExecutor(session.live.db, replaying, verifier, () => ACTIVE, session.live.provider)
        .execute(session.live.command.request_id)).rejects.toMatchObject({ code: "COMPANY_SB_RECEIPT_INVALID" });

      expect(existsSync(effect)).toBe(false);
      expect(session.live.db.db.prepare("SELECT count(*) AS n FROM company_candidate_sb_receipts").get()).toEqual({ n: 0 });
      expect(session.live.db.db.prepare("SELECT status,completion_json,lease_token FROM company_candidate_handoffs").get())
        .toEqual({ status: "uncertain", completion_json: null, lease_token: null });
      expect(session.peer.counts()).toEqual({ accept: 1, reject: 0, mark_processed: 0, read: 2 });
    } finally { await session.peer.close(); session.live.close(); }
  });

  it("runs schema 2 completion only after a durable child effect", async () => {
    const session = await withPeer("ok");
    const effect = join(session.live.root, "effect");
    const executable = join(session.live.root, "verify");
    writeFileSync(executable, `#!${process.execPath}
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  const input = JSON.parse(data);
  if (input.schema_version !== 2) process.exit(2);
  writeFileSync(${JSON.stringify(effect)}, "verified-v2-effect", { mode: 0o600, flag: "wx" });
  const bytes = readFileSync(${JSON.stringify(effect)});
  process.stdout.write(JSON.stringify({
    schema_version: 2, state: "completed", request_id: input.command.request_id,
    command_digest: input.command_digest ?? ${JSON.stringify(session.live.digest)},
    candidate_id: input.command.target.candidate_id, content_digest: input.command.target.content_digest,
    acceptance_receipt_digest: input.acceptance.receipt_digest,
    effect_digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
  }));
});
`, { mode: 0o700 });
    writeFileSync(join(session.live.root, "completion.json"), JSON.stringify({
      schema_version: 2, executable, args: [],
    }), { mode: 0o600 });
    try {
      const verifier = createCompanyCompletionVerifierV2(join(session.live.root, "completion.json"));
      const executor = new CompanyCandidateExecutor(session.live.db, session.client, verifier, () => ACTIVE, session.live.provider);
      const result = await executor.execute(session.live.command.request_id);
      expect(result.state).toBe("completed");
      expect((await executor.execute(session.live.command.request_id)).state).toBe("completed");
      expect(readFileSync(effect, "utf8")).toBe("verified-v2-effect");
      expect(session.peer.counts()).toEqual({ accept: 1, reject: 0, mark_processed: 1, read: 0 });
      expect(createHash("sha256").update(readFileSync(effect)).digest("hex")).toHaveLength(64);
    } finally { await session.peer.close(); session.live.close(); }
  });

  it.each([
    ["schema-1", "result.schema_version = 1;"],
    ["request", "result.request_id = 'different-request';"],
    ["command", `result.command_digest = "sha256:${"a".repeat(64)}";`],
    ["candidate", "result.candidate_id = 'different-candidate';"],
    ["content", `result.content_digest = "sha256:${"b".repeat(64)}";`],
    ["acceptance", `result.acceptance_receipt_digest = "sha256:${"c".repeat(64)}";`],
    ["echo-only", "result.effect_digest = result.command_digest;"],
    ["unknown-field", "result.extra = true;"],
    ["malformed", "process.stdout.write('{'); return;"],
    ["multiple-objects", "process.stdout.write('{}{}'); return;"],
    ["duplicate-field", `process.stdout.write(JSON.stringify(result).replace('"schema_version":2', '"schema_version":2,"schema_version":2')); return;`],
    ["oversize", "process.stdout.write('x'.repeat(1048577)); return;"],
    ["exit", "process.exit(3);"],
  ] as const)("rejects verifier %s and clears the lease", async (_name, body) => {
    const session = await withPeer("ok");
    const executable = join(session.live.root, "verify");
    writeFileSync(executable, `#!${process.execPath}
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { data += chunk; });
process.stdin.on("end", () => {
  const input = JSON.parse(data);
  const result = {
    schema_version: 2, state: "completed", request_id: input.command.request_id,
    command_digest: ${JSON.stringify(session.live.digest)},
    candidate_id: input.command.target.candidate_id, content_digest: input.command.target.content_digest,
    acceptance_receipt_digest: input.acceptance.receipt_digest, effect_digest: "sha256:${"e".repeat(64)}",
  };
  ${body}
  process.stdout.write(JSON.stringify(result));
});
`, { mode: 0o700 });
    writeFileSync(join(session.live.root, "completion.json"), JSON.stringify({
      schema_version: 2, executable, args: [],
    }), { mode: 0o600 });
    try {
      const verifier = createCompanyCompletionVerifierV2(join(session.live.root, "completion.json"));
      const executor = new CompanyCandidateExecutor(session.live.db, session.client, verifier, () => ACTIVE, session.live.provider);
      await expect(executor.execute(session.live.command.request_id)).rejects.toMatchObject({ code: "COMPANY_VERIFIER_INVALID" });
      expect(session.live.db.db.prepare("SELECT lease_token FROM company_candidate_handoffs").get()).toEqual({ lease_token: null });
      expect(session.peer.counts().mark_processed).toBe(0);
      expect(session.peer.counts().accept).toBe(1);
    } finally { await session.peer.close(); session.live.close(); }
  });

  const invalidInjected: ReadonlyArray<readonly [string, (value: CompanyCompletionV2) => CompanyCompletionV2]> = [
    ["request", value => ({ ...value, request_id: "different-request" })],
    ["command", value => ({ ...value, command_digest: `sha256:${"a".repeat(64)}` })],
    ["candidate", value => ({ ...value, candidate_id: "different-candidate" })],
    ["content", value => ({ ...value, content_digest: `sha256:${"b".repeat(64)}` })],
    ["acceptance", value => ({ ...value, acceptance_receipt_digest: `sha256:${"c".repeat(64)}` })],
    ["unknown-field", value => ({ ...value, extra: true })],
    ["echo-command", value => ({ ...value, effect_digest: value.command_digest })],
    ["echo-content", value => ({ ...value, effect_digest: value.content_digest })],
    ["echo-acceptance", value => ({ ...value, effect_digest: value.acceptance_receipt_digest })],
  ];

  it.each(invalidInjected)("rejects injected verifier %s before storing completion", async (_name, corrupt) => {
    const session = await withPeer("ok");
    const verifier: CompanyCompletionVerifierV2 = {
      version: 2,
      async verify(command, acceptance, commandDigest) {
        return corrupt({
          schema_version: 2, state: "completed", request_id: command.request_id,
          command_digest: commandDigest, candidate_id: command.target.candidate_id,
          content_digest: command.target.content_digest, acceptance_receipt_digest: acceptance.receipt_digest,
          effect_digest: `sha256:${"e".repeat(64)}`,
        });
      },
    };
    try {
      const executor = new CompanyCandidateExecutor(session.live.db, session.client, verifier, () => ACTIVE, session.live.provider);
      await expect(executor.execute(session.live.command.request_id)).rejects.toMatchObject({ code: "COMPANY_VERIFIER_INVALID" });
      expect(session.live.db.db.prepare("SELECT completion_json,lease_token FROM company_candidate_handoffs").get())
        .toEqual({ completion_json: null, lease_token: null });
      expect(session.live.db.db.prepare(
        "SELECT evidence_digest,finished_checkpoint_json FROM company_progress_reservations WHERE operation='complete'",
      ).get()).toEqual({ evidence_digest: null, finished_checkpoint_json: null });
      expect(session.peer.counts()).toEqual({ accept: 1, reject: 0, mark_processed: 0, read: 0 });
    } finally { await session.peer.close(); session.live.close(); }
  });

  it("clears the lease when the verifier times out", async () => {
    const live = await companyApproverV2Database();
    const peer = await startJarvisCompanyTestPeer("ok");
    const configPath = processorConfig(live.root, peer.socketPath);
    const client = createCompanyClient(configPath, "processor");
    const gatePath = join(live.root, "gate.sock");
    const gate = createServer();
    const entered = once(gate, "connection", { signal: AbortSignal.timeout(5_000) });
    gate.listen(gatePath);
    await once(gate, "listening");
    const executable = join(live.root, "verify");
    writeFileSync(executable, `#!${process.execPath}
import { createConnection } from "node:net";
import { once } from "node:events";
const socket = createConnection(${JSON.stringify(gatePath)});
await once(socket, "connect");
socket.write("ready\\n");
await new Promise(() => {});
`, { mode: 0o700 });
    writeFileSync(join(live.root, "completion.json"), JSON.stringify({ schema_version: 2, executable, args: [] }), { mode: 0o600 });
    const realExecFile = childProcess.execFile;
    const target: Record<string, unknown> = childProcess;
    const children: ChildProcess[] = [];
    target.execFile = (...args: Parameters<typeof realExecFile>) => {
      const child = realExecFile(...args);
      children.push(child);
      return child;
    };
    syncBuiltinESMExports();
    let execution: Promise<unknown> | undefined;
    try {
      const verifier = createCompanyCompletionVerifierV2(join(live.root, "completion.json"));
      const executor = new CompanyCandidateExecutor(live.db, client, verifier, () => ACTIVE, live.provider);
      const started = Date.now();
      execution = executor.execute(live.command.request_id).catch((error: unknown) => error);
      const [channel] = await entered;
      await once(channel, "data", { signal: AbortSignal.timeout(5_000) });
      channel.resume();
      const child = children[0];
      if (!child) throw new Error("verifier child missing");
      await once(child, "close", { signal: AbortSignal.timeout(13_000) });
      expect(child.signalCode).toBe("SIGKILL");
      expect(Date.now() - started).toBeLessThan(13_000);
      expect(await execution).toMatchObject({ code: "COMPANY_VERIFIER_INVALID" });
      expect(live.db.db.prepare("SELECT lease_token,status FROM company_candidate_handoffs").get())
        .toMatchObject({ lease_token: null, status: "uncertain" });
      expect(peer.counts().mark_processed).toBe(0);
    } finally {
      target.execFile = realExecFile;
      syncBuiltinESMExports();
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const settled = once(child, "close");
          child.kill("SIGKILL");
          await settled;
        }
      }
      await execution;
      await new Promise<void>(resolve => gate.close(() => resolve()));
      await peer.close();
      live.close();
    }
  }, 20_000);
});
