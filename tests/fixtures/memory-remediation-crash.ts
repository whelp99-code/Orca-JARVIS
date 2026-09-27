import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

const resultSchema = z.object({ kind: z.literal("recovered"), result: z.object({ ok: z.literal(true), command: z.literal("memory.lifecycle") }),
  rows: z.array(z.object({ state: z.literal("settled"), request_id: z.string() })).length(1), recovered: z.array(z.string()),
  tombstones: z.literal(1), purges: z.literal(1), frames: z.literal(1), effects: z.literal(1),
  effect_rows: z.object({ count: z.literal(1) }), redemption_rows: z.object({ count: z.literal(1) }) });

export async function runRecoveryCrash(input: {
  readonly lane: "correction" | "deletion";
  readonly barrier: "jarvis_suppression_tombstone_commit" | "before_settlement_commit" | "provider_accepted_before_local_persistence";
  readonly status?: "pending" | "proved";
}) {
  const root = mkdtempSync(join(tmpdir(), "task30-remediation-crash-"));
  const descriptor = join(root, "descriptor.json");
  const channels: ReturnType<typeof start>[] = [];
  function start(mode: "hold" | "recover") {
    const child = spawn(process.execPath, [resolve("dist/tests/fixtures/memory-remediation-crash-worker.js"),
      mode, descriptor, input.lane, input.barrier, input.status ?? "proved"], { env: { PATH: "/usr/bin:/bin", HOME: root } });
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const closed = once(child, "close", { signal: AbortSignal.timeout(25_000) });
    const output = once(lines, "line", { signal: AbortSignal.timeout(20_000) });
    child.stdin.write("GO\n");
    return { child, lines, closed, output, stderr: () => stderr };
  }
  try {
    const first = start("hold"); channels.push(first);
    const [event] = await Promise.race([first.output, first.closed.then(() => { throw new Error(`WORKER_EXITED:${first.stderr()}`); })]);
    z.object({ kind: z.literal("barrier"), barrier_id: z.literal(input.barrier) }).parse(JSON.parse(String(event)));
    first.child.kill("SIGKILL");
    const killed = await first.closed;
    if (killed[1] !== "SIGKILL") throw new Error(`CRASH_NOT_CONFIRMED:${first.stderr()}`);
    const restarted = start("recover"); channels.push(restarted);
    const [line] = await Promise.race([restarted.output, restarted.closed.then(() => { throw new Error(`RECOVERY_EXITED:${restarted.stderr()}`); })]);
    const exited = await restarted.closed;
    if (exited[0] !== 0) throw new Error(`RECOVERY_FAILED:${restarted.stderr()}`);
    const value: unknown = JSON.parse(String(line));
    if (input.barrier === "provider_accepted_before_local_persistence") return z.object({
      kind: z.literal("recovered"), result: z.object({ ok: z.literal(true), command: z.literal("memory.lifecycle") }),
      rows: z.array(z.object({ state: z.string(), request_id: z.string(), request_digest: z.string(),
        envelope_digest: z.string(), delegation_id: z.string(), delegation_digest: z.string(),
        expires_at: z.string(), dispatch_fence: z.number(), tombstone_sequence: z.number() })).length(1),
      recovered: z.array(z.string()), tombstones: z.number(), purges: z.number(), frames: z.number(), effects: z.number(),
      effect_rows: z.object({ count: z.number() }), redemption_rows: z.object({ count: z.number() }),
      status_reads: z.number(), accepted_through: z.number(), reconciled_spools: z.number(),
      attempt_rows: z.number(), original_request: z.object({
        request_id: z.string(), request_digest: z.string(), envelope_digest: z.string(), expires_at: z.string(),
        delegation: z.object({ delegation_id: z.string(), delegation_digest: z.string(), signing_key_id: z.string() }),
      }),
    }).parse(value);
    return resultSchema.parse(value);
  } finally {
    for (const channel of channels) {
      channel.lines.close();
      if (channel.child.exitCode === null && channel.child.signalCode === null) channel.child.kill("SIGKILL");
    }
    await Promise.all(channels.map(channel => channel.closed));
    if (existsSync(descriptor)) {
      const paths = z.object({ root: z.string(), anchors: z.string(), database_root: z.string() })
        .parse(JSON.parse(readFileSync(descriptor, "utf8")));
      for (const path of Object.values(paths)) rmSync(path, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
}
